import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_PROVIDER } from '../email/email.provider';
import type { EmailProvider } from '../email/email.provider';
import { TrackingService } from '../tracking/tracking.service';
import { AnalyticsService } from '../analytics/analytics.service';

export interface SaveStepDto {
  stepOrder: number;
  delayHours: number;
  sendAsReply?: boolean;
  subject?: string;
  htmlBody: string;
  templateId?: string;
}

export interface ContactEntry {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  attributes?: any;
}

@Injectable()
export class CampaignSequencesService {
  private readonly logger = new Logger(CampaignSequencesService.name);
  private isProcessingCron = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly trackingService: TrackingService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /**
   * Saves / updates all steps for a campaign sequence.
   */
  async saveSteps(campaignId: string, steps: SaveStepDto[]) {
    if (!steps || steps.length === 0) {
      throw new BadRequestException('At least 1 sequence step is required.');
    }

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    // Sort by stepOrder
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);

    // Save in transaction: delete existing and create new
    return (this.prisma as any).$transaction(async (tx: any) => {
      await tx.campaignStep.deleteMany({ where: { campaignId } });

      const created: any[] = [];

      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const step = await tx.campaignStep.create({
          data: {
            campaignId,
            stepOrder: i + 1,
            delayHours: Math.max(0, s.delayHours || 0),
            sendAsReply: s.sendAsReply ?? (i > 0),
            subject: s.subject || undefined,
            htmlBody: s.htmlBody || '',
            templateId: s.templateId || undefined,
          },
        });
        created.push(step);
      }

      await tx.campaign.update({
        where: { id: campaignId },
        data: { isSequence: true },
      });

      return created;
    });
  }

  /**
   * Retrieves all steps for a campaign.
   */
  async getSteps(campaignId: string) {
    return this.prisma.campaignStep.findMany({
      where: { campaignId },
      orderBy: { stepOrder: 'asc' },
    });
  }

  /**
   * Starts a sequence campaign: initializes CampaignLead for all active audience contacts
   * and immediately dispatches Step 1.
   */
  async startSequence(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        audience: {
          include: {
            workspace: { select: { id: true } },
            contacts: { select: { id: true, email: true, firstName: true, lastName: true, attributes: true } },
          },
        },
        steps: { orderBy: { stepOrder: 'asc' } },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    if (campaign.steps.length === 0) {
      throw new BadRequestException('Cannot start sequence: no sequence steps configured.');
    }

    // Fetch suppression emails
    const workspaceId = campaign.audience.workspace.id;
    const suppressions = await this.prisma.suppression.findMany({
      where: { workspaceId },
      select: { email: true },
    });
    const suppressedSet = new Set(suppressions.map((s) => s.email.toLowerCase()));

    // Filter active contacts
    const activeContacts = campaign.audience.contacts.filter(
      (c) => !suppressedSet.has(c.email.toLowerCase()),
    );

    // Update campaign status
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'SENDING', isSequence: true },
    });

    const step1 = campaign.steps[0];
    const step2 = campaign.steps.find((s) => s.stepOrder === 2);
    const hasNextStep = !!step2;

    const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const defaultFrom = process.env.AWS_SES_FROM_ADDRESS || 'noreply@digireps.org';
    const senderEmail = (campaign as any).fromEmail?.trim() || defaultFrom;
    const senderFrom = (campaign as any).fromName?.trim()
      ? `"${(campaign as any).fromName.trim()}" <${senderEmail}>`
      : senderEmail;
    const replyTo = (campaign as any).replyTo?.trim()
      ? [(campaign as any).replyTo.trim()]
      : [senderEmail];

    this.logger.log(
      `Starting sequence for campaign ${campaignId}: ${activeContacts.length} active leads to process at Step 1`,
    );

    // Process Step 1 for each active contact
    for (const contact of activeContacts) {
      try {
        // Upsert CampaignLead
        const lead = await this.prisma.campaignLead.upsert({
          where: {
            campaignId_contactId: { campaignId, contactId: contact.id },
          },
          update: { currentStep: 1, status: 'ACTIVE' },
          create: {
            campaignId,
            contactId: contact.id,
            currentStep: 1,
            status: 'ACTIVE',
          },
        });

        // Render Step 1
        const rawSubject = step1.subject || campaign.subject || campaign.name;
        const personalSubject = this.renderMergeTags(rawSubject, contact);
        let personalHtml = this.renderMergeTags(step1.htmlBody || campaign.htmlBody || '', contact);

        // Generate Message record for tracking
        const msg = await this.prisma.message.upsert({
          where: {
            campaignId_contactId_stepNumber: {
              campaignId,
              contactId: contact.id,
              stepNumber: 1,
            },
          },
          update: { enqueuedAt: new Date() },
          create: {
            campaignId,
            contactId: contact.id,
            stepNumber: 1,
            enqueuedAt: new Date(),
          },
        });

        const unsubToken = this.trackingService.generateToken(msg.id);
        const unsubUrl = `${baseUrl}/t/unsub/${unsubToken}`;

        if (/\{\{\s*unsubscribe(?:_url)?\s*\}\}/i.test(personalHtml)) {
          personalHtml = personalHtml.replace(/\{\{\s*unsubscribe(?:_url)?\s*\}\}/gi, unsubUrl);
        } else {
          const unsubFooter = `\n<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;text-align:center;font-size:12px;color:#888;">\n  <a href="${unsubUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a>\n</div>`;
          personalHtml += unsubFooter;
        }

        try {
          await this.trackingService.saveToken(msg.id, unsubToken);
          personalHtml = this.trackingService.wrapHtml(personalHtml, unsubToken, baseUrl);
        } catch (tErr: any) {
          this.logger.warn(`Tracking token save error: ${tErr?.message}`);
        }

        // Dispatch email via SES
        const sendResult = await this.emailProvider.send({
          to: contact.email,
          subject: personalSubject,
          html: personalHtml,
          from: senderFrom,
          replyTo,
          listUnsubscribeUrl: unsubUrl,
        });

        const providerId = sendResult.providerId || msg.id;

        // Schedule next step or complete
        const now = new Date();
        if (hasNextStep && step2) {
          const nextSendAt = new Date(now.getTime() + (step2.delayHours || 48) * 3600000);
          await this.prisma.campaignLead.update({
            where: { id: lead.id },
            data: {
              currentStep: 2,
              status: 'WAITING_DELAY',
              rootMessageId: providerId,
              lastSentAt: now,
              nextSendAt,
            },
          });
        } else {
          await this.prisma.campaignLead.update({
            where: { id: lead.id },
            data: {
              status: 'COMPLETED',
              rootMessageId: providerId,
              lastSentAt: now,
              nextSendAt: null,
            },
          });
        }
      } catch (err: any) {
        this.logger.error(`Failed to dispatch Step 1 for contact ${contact.email}: ${err?.message}`);
      }
    }

    // Refresh analytics snapshot
    try {
      await this.analyticsService.computeForCampaign(campaignId);
    } catch {}

    return { campaignId, status: 'SENDING', leadsCount: activeContacts.length };
  }

  /**
   * Background Cron: Runs every 2 minutes to check and dispatch due follow-up steps.
   */
  @Cron('*/2 * * * *')
  async processDueFollowups() {
    if (this.isProcessingCron) return;
    this.isProcessingCron = true;

    try {
      const now = new Date();
      const dueLeads = await this.prisma.campaignLead.findMany({
        where: {
          status: 'WAITING_DELAY',
          nextSendAt: { lte: now },
          campaign: { status: 'SENDING' },
        },
        include: {
          contact: true,
          campaign: {
            include: {
              steps: { orderBy: { stepOrder: 'asc' } },
              audience: { include: { workspace: { select: { id: true } } } },
            },
          },
        },
        take: 100, // Batch size per execution
      });

      if (dueLeads.length === 0) {
        this.isProcessingCron = false;
        return;
      }

      this.logger.log(`[Follow-up Cron] Processing ${dueLeads.length} due follow-up lead(s)...`);

      const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
      const defaultFrom = process.env.AWS_SES_FROM_ADDRESS || 'noreply@digireps.org';

      for (const lead of dueLeads) {
        try {
          const campaign = lead.campaign;
          const contact = lead.contact;
          const workspaceId = campaign.audience.workspace.id;

          // Check if contact has been suppressed / unsubscribed in the meantime
          const isSuppressed = await this.prisma.suppression.findUnique({
            where: {
              workspaceId_email: { workspaceId, email: contact.email.toLowerCase() },
            },
          });

          if (isSuppressed) {
            this.logger.log(`Lead ${contact.email} is suppressed — cancelling remaining follow-up steps.`);
            await this.prisma.campaignLead.update({
              where: { id: lead.id },
              data: { status: 'UNSUBSCRIBED', nextSendAt: null },
            });
            continue;
          }

          // Locate current step
          const currentStepOrder = lead.currentStep;
          const currentStep = campaign.steps.find((s) => s.stepOrder === currentStepOrder);

          if (!currentStep) {
            this.logger.warn(`Step ${currentStepOrder} not found for campaign ${campaign.id} — marking lead completed.`);
            await this.prisma.campaignLead.update({
              where: { id: lead.id },
              data: { status: 'COMPLETED', nextSendAt: null },
            });
            continue;
          }

          // Determine Subject and Threading
          const initialSubject = campaign.subject || campaign.name;
          let emailSubject: string;
          if (currentStep.sendAsReply) {
            emailSubject = initialSubject.toLowerCase().startsWith('re:')
              ? initialSubject
              : `Re: ${initialSubject}`;
          } else {
            emailSubject = currentStep.subject || initialSubject;
          }

          const personalSubject = this.renderMergeTags(emailSubject, contact);
          let personalHtml = this.renderMergeTags(currentStep.htmlBody || '', contact);

          // Create/upsert Message record for analytics
          const msg = await this.prisma.message.upsert({
            where: {
              campaignId_contactId_stepNumber: {
                campaignId: campaign.id,
                contactId: contact.id,
                stepNumber: currentStepOrder,
              },
            },
            update: { enqueuedAt: now },
            create: {
              campaignId: campaign.id,
              contactId: contact.id,
              stepNumber: currentStepOrder,
              enqueuedAt: now,
            },
          });

          const unsubToken = this.trackingService.generateToken(msg.id);
          const unsubUrl = `${baseUrl}/t/unsub/${unsubToken}`;

          if (/\{\{\s*unsubscribe(?:_url)?\s*\}\}/i.test(personalHtml)) {
            personalHtml = personalHtml.replace(/\{\{\s*unsubscribe(?:_url)?\s*\}\}/gi, unsubUrl);
          } else {
            const unsubFooter = `\n<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;text-align:center;font-size:12px;color:#888;">\n  <a href="${unsubUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a>\n</div>`;
            personalHtml += unsubFooter;
          }

          try {
            await this.trackingService.saveToken(msg.id, unsubToken);
            personalHtml = this.trackingService.wrapHtml(personalHtml, unsubToken, baseUrl);
          } catch {}

          const senderEmail = (campaign as any).fromEmail?.trim() || defaultFrom;
          const senderFrom = (campaign as any).fromName?.trim()
            ? `"${(campaign as any).fromName.trim()}" <${senderEmail}>`
            : senderEmail;
          const replyTo = (campaign as any).replyTo?.trim()
            ? [(campaign as any).replyTo.trim()]
            : [senderEmail];

          // Send via SES with In-Reply-To and References if sending as reply
          await this.emailProvider.send({
            to: contact.email,
            subject: personalSubject,
            html: personalHtml,
            from: senderFrom,
            replyTo,
            listUnsubscribeUrl: unsubUrl,
            inReplyTo: currentStep.sendAsReply && lead.rootMessageId ? lead.rootMessageId : undefined,
            references: currentStep.sendAsReply && lead.rootMessageId ? lead.rootMessageId : undefined,
          });

          this.logger.log(
            `[Follow-up Cron] Dispatched Step ${currentStepOrder} to ${contact.email} (Campaign: ${campaign.name})`,
          );

          // Advance to next step or mark completed
          const nextStepOrder = currentStepOrder + 1;
          const nextStep = campaign.steps.find((s) => s.stepOrder === nextStepOrder);

          if (nextStep) {
            const nextSendAt = new Date(now.getTime() + (nextStep.delayHours || 48) * 3600000);
            await this.prisma.campaignLead.update({
              where: { id: lead.id },
              data: {
                currentStep: nextStepOrder,
                status: 'WAITING_DELAY',
                lastSentAt: now,
                nextSendAt,
              },
            });
          } else {
            // Sequence finished for this lead!
            await this.prisma.campaignLead.update({
              where: { id: lead.id },
              data: {
                status: 'COMPLETED',
                lastSentAt: now,
                nextSendAt: null,
              },
            });
          }
        } catch (leadErr: any) {
          this.logger.error(`Failed to process follow-up lead ${lead.id}: ${leadErr?.message}`);
        }
      }
    } catch (cronErr: any) {
      this.logger.error(`processDueFollowups error: ${cronErr?.message}`);
    } finally {
      this.isProcessingCron = false;
    }
  }

  /**
   * Retrieves summary and lead progression across sequence steps.
   */
  async getSequenceProgress(campaignId: string) {
    const [steps, leads, statusCounts] = await Promise.all([
      this.prisma.campaignStep.findMany({
        where: { campaignId },
        orderBy: { stepOrder: 'asc' },
      }),
      this.prisma.campaignLead.findMany({
        where: { campaignId },
        include: {
          contact: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.campaignLead.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { id: true },
      }),
    ]);

    const stepBreakdown = steps.map((s) => {
      const activeAtStep = leads.filter(
        (l) => l.currentStep === s.stepOrder && (l.status === 'ACTIVE' || l.status === 'WAITING_DELAY'),
      ).length;
      const sentAtStep = leads.filter(
        (l) => l.currentStep > s.stepOrder || (l.currentStep === s.stepOrder && l.lastSentAt !== null),
      ).length;

      return {
        stepOrder: s.stepOrder,
        delayHours: s.delayHours,
        sendAsReply: s.sendAsReply,
        subject: s.subject,
        activeAtStep,
        sentAtStep,
      };
    });

    const statusMap: Record<string, number> = {};
    for (const sc of statusCounts) {
      statusMap[sc.status] = sc._count.id;
    }

    return {
      totalLeads: leads.length,
      steps: stepBreakdown,
      statusCounts: {
        ACTIVE: statusMap['ACTIVE'] || 0,
        WAITING_DELAY: statusMap['WAITING_DELAY'] || 0,
        COMPLETED: statusMap['COMPLETED'] || 0,
        PAUSED: statusMap['PAUSED'] || 0,
        UNSUBSCRIBED: statusMap['UNSUBSCRIBED'] || 0,
        REPLIED: statusMap['REPLIED'] || 0,
        BOUNCED: statusMap['BOUNCED'] || 0,
      },
      leads: leads.slice(0, 100).map((l) => ({
        id: l.id,
        email: l.contact.email,
        name: [l.contact.firstName, l.contact.lastName].filter(Boolean).join(' ') || '—',
        currentStep: l.currentStep,
        status: l.status,
        lastSentAt: l.lastSentAt,
        nextSendAt: l.nextSendAt,
      })),
    };
  }

  // Helper for merge tags
  private renderMergeTags(templateText: string, contact: ContactEntry): string {
    return templateText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'first_name' || lowerKey === 'firstname') return contact.firstName ?? '';
      if (lowerKey === 'last_name' || lowerKey === 'lastname') return contact.lastName ?? '';
      if (lowerKey === 'email') return contact.email;

      if (contact.attributes && typeof contact.attributes === 'object') {
        const attrs = contact.attributes as Record<string, any>;
        if (attrs[key] !== undefined && attrs[key] !== null) return String(attrs[key]);
        if (attrs[lowerKey] !== undefined && attrs[lowerKey] !== null) return String(attrs[lowerKey]);
        const noUnder = lowerKey.replace(/_/g, '');
        const foundKey = Object.keys(attrs).find((k) => k.toLowerCase().replace(/_/g, '') === noUnder);
        if (foundKey && attrs[foundKey] !== undefined && attrs[foundKey] !== null) return String(attrs[foundKey]);
      }
      return '';
    });
  }
}