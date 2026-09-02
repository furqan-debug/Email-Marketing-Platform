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
  delayHours?: number;
  scheduledAt?: string | null;
  sendAtTime?: string | null;
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
   * Helper to calculate the nextSendAt date based on custom delay, preferred time of day, or specific calendar date.
   */
  public calculateNextSendAt(step: any, baseDate: Date = new Date()): Date {
    if (step.scheduledAt) {
      const scheduled = new Date(step.scheduledAt);
      if (!isNaN(scheduled.getTime())) {
        return scheduled;
      }
    }

    const delayHours = typeof step.delayHours === 'number' ? step.delayHours : 48;
    const delayMs = Math.max(0, delayHours * 3600000);
    let targetDate = new Date(baseDate.getTime() + delayMs);

    if (step.sendAtTime && typeof step.sendAtTime === 'string') {
      const [h, m] = step.sendAtTime.split(':').map(Number);
      if (!isNaN(h) && !isNaN(m)) {
        targetDate.setHours(h, m, 0, 0);
        if (targetDate.getTime() < baseDate.getTime()) {
          targetDate = new Date(targetDate.getTime() + 24 * 3600000);
        }
      }
    }

    return targetDate;
  }

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
            delayHours: s.delayHours !== undefined ? Number(s.delayHours) : (i === 0 ? 0 : 48),
            scheduledAt: s.scheduledAt ? new Date(s.scheduledAt) : null,
            sendAtTime: s.sendAtTime || null,
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

    this.logger.log(
      `Starting sequence for campaign ${campaignId}: ${activeContacts.length} active leads to process at Step 1`,
    );

    // Launch dispatch in background so HTTP response is instant
    setImmediate(async () => {
      try {
        await this.dispatchStep1(campaignId, activeContacts);
      } catch (err: any) {
        this.logger.error(`Error in dispatchStep1 for campaign ${campaignId}: ${err?.message ?? err}`);
      }
    });

    return { campaignId, status: 'SENDING', leadsCount: activeContacts.length };
  }

  /**
   * Background dispatcher for Step 1 of a sequence campaign.
   */
  private async dispatchStep1(campaignId: string, activeContacts: any[]) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
      },
    });

    if (!campaign || campaign.steps.length === 0) return;

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

    // Process Step 1 for each active contact
    for (const contact of activeContacts) {
      try {
        // Check if campaign was paused/cancelled mid-loop
        const currentCamp = await this.prisma.campaign.findUnique({
          where: { id: campaignId },
          select: { status: true },
        });
        if (currentCamp?.status === 'PAUSED' || currentCamp?.status === 'CANCELLED') {
          this.logger.log(`Campaign ${campaignId} was paused/cancelled — halting Step 1 dispatch.`);
          break;
        }

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

        // Safe message record lookup/creation (avoid ON CONFLICT constraint mismatch)
        let msg = await this.prisma.message.findFirst({
          where: {
            campaignId,
            contactId: contact.id,
            stepNumber: 1,
          },
        });

        if (!msg) {
          msg = await this.prisma.message.create({
            data: {
              campaignId,
              contactId: contact.id,
              stepNumber: 1,
              enqueuedAt: new Date(),
            },
          });
        } else {
          await this.prisma.message.update({
            where: { id: msg.id },
            data: { enqueuedAt: new Date() },
          });
        }

        // Render Step 1
        const rawSubject = step1.subject || campaign.subject || campaign.name;
        const personalSubject = this.renderMergeTags(rawSubject, contact);
        let personalHtml = this.renderMergeTags(step1.htmlBody || campaign.htmlBody || '', contact);

        const unsubToken = this.trackingService.generateToken(msg.id);
        const unsubUrl = `${baseUrl}/t/unsub/${unsubToken}`;

        if (/\{\{\s*unsubscribe(?:_url)?\s*\}\}/i.test(personalHtml)) {
          personalHtml = personalHtml.replace(/\{\{\s*unsubscribe(?:_url)?\s*\}\}/gi, unsubUrl);
        }


        try {
          await this.trackingService.saveToken(msg.id, unsubToken);
          personalHtml = this.trackingService.wrapHtml(personalHtml, unsubToken, baseUrl, {
            trackOpens: (campaign as any).trackOpens ?? true,
            trackClicks: (campaign as any).trackClicks ?? true,
          });
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
          const nextSendAt = this.calculateNextSendAt(step2, now);
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

        // Small delay (50ms) to respect SES rate limit
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err: any) {
        this.logger.error(`Failed to dispatch Step 1 for contact ${contact.email}: ${err?.message ?? err}`);
      }
    }

    // Refresh analytics snapshot
    try {
      await this.analyticsService.computeForCampaign(campaignId);
    } catch {}
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

          // Safe message record lookup/creation
          let msg = await this.prisma.message.findFirst({
            where: {
              campaignId: campaign.id,
              contactId: contact.id,
              stepNumber: currentStepOrder,
            },
          });
          if (!msg) {
            msg = await this.prisma.message.create({
              data: {
                campaignId: campaign.id,
                contactId: contact.id,
                stepNumber: currentStepOrder,
                enqueuedAt: now,
              },
            });
          } else {
            await this.prisma.message.update({
              where: { id: msg.id },
              data: { enqueuedAt: now },
            });
          }


          const unsubToken = this.trackingService.generateToken(msg.id);
          const unsubUrl = `${baseUrl}/t/unsub/${unsubToken}`;

          if (/\{\{\s*unsubscribe(?:_url)?\s*\}\}/i.test(personalHtml)) {
            personalHtml = personalHtml.replace(/\{\{\s*unsubscribe(?:_url)?\s*\}\}/gi, unsubUrl);
          }


          try {
            await this.trackingService.saveToken(msg.id, unsubToken);
            personalHtml = this.trackingService.wrapHtml(personalHtml, unsubToken, baseUrl, {
              trackOpens: (campaign as any).trackOpens ?? true,
              trackClicks: (campaign as any).trackClicks ?? true,
            });
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
            const nextSendAt = this.calculateNextSendAt(nextStep, now);
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

      // Automatically transition any campaigns with 0 pending leads to COMPLETED
      const activeCampaigns = await this.prisma.campaign.findMany({
        where: { status: 'SENDING', isSequence: true },
        include: { leads: { select: { status: true } } },
      });

      for (const camp of activeCampaigns) {
        if (camp.leads.length > 0) {
          const hasPending = camp.leads.some(
            (l) => l.status === 'ACTIVE' || l.status === 'WAITING_DELAY',
          );
          if (!hasPending) {
            await this.prisma.campaign.update({
              where: { id: camp.id },
              data: { status: 'COMPLETED' },
            });
            this.logger.log(`Campaign ${camp.name} (${camp.id}) completed — all sequence steps finished.`);
          }
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
    const [steps, leads, statusCounts, stepEvents] = await Promise.all([
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
      this.prisma.client.$queryRaw<
        Array<{ stepNumber: number; type: string; count: bigint }>
      >`
        SELECT
          m."stepNumber",
          e.type,
          COUNT(DISTINCT e."messageId") as count
        FROM "Event" e
        INNER JOIN "Message" m ON m.id = e."messageId"
        WHERE m."campaignId" = ${campaignId}
        GROUP BY m."stepNumber", e.type
      `,
    ]);

    const stepStatsMap: Record<number, { opens: number; clicks: number; replies: number }> = {};
    for (const row of stepEvents) {
      const step = Number(row.stepNumber);
      if (!stepStatsMap[step]) {
        stepStatsMap[step] = { opens: 0, clicks: 0, replies: 0 };
      }
      const count = Number(row.count);
      if (row.type === 'Open') stepStatsMap[step].opens = count;
      if (row.type === 'Click') stepStatsMap[step].clicks = count;
      if (row.type === 'Reply') stepStatsMap[step].replies = count;
    }

    const stepBreakdown = steps.map((s) => {
      const activeAtStep = leads.filter(
        (l) => l.currentStep === s.stepOrder && (l.status === 'ACTIVE' || l.status === 'WAITING_DELAY'),
      ).length;
      const sentAtStep = leads.filter(
        (l) => l.currentStep > s.stepOrder || (l.currentStep === s.stepOrder && l.lastSentAt !== null),
      ).length;
      const stats = stepStatsMap[s.stepOrder] || { opens: 0, clicks: 0, replies: 0 };

      return {
        stepOrder: s.stepOrder,
        delayHours: s.delayHours,
        sendAsReply: s.sendAsReply,
        subject: s.subject,
        activeAtStep,
        sentAtStep,
        opensAtStep: stats.opens,
        clicksAtStep: stats.clicks,
        repliesAtStep: stats.replies,
      };
    });


    const statusMap: Record<string, number> = {};
    for (const sc of statusCounts) {
      statusMap[sc.status] = sc._count.id;
    }

    const activeWaiting = (statusMap['ACTIVE'] || 0) + (statusMap['WAITING_DELAY'] || 0);
    if (leads.length > 0 && activeWaiting === 0) {
      const camp = await this.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });
      if (camp && camp.status === 'SENDING') {
        await this.prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'COMPLETED' },
        });
      }
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

  /**
   * Manually or via webhook marks a lead as REPLIED.
   * Halts any pending follow-ups, records a Reply event, and updates analytics.
   */
  async markLeadReplied(campaignId: string, leadIdOrContactId: string) {
    const lead = await this.prisma.campaignLead.findFirst({
      where: {
        campaignId,
        OR: [{ id: leadIdOrContactId }, { contactId: leadIdOrContactId }],
      },
      include: { contact: true },
    });

    if (!lead) {
      throw new NotFoundException(`Lead ${leadIdOrContactId} not found in campaign ${campaignId}`);
    }

    const updated = await this.prisma.campaignLead.update({
      where: { id: lead.id },
      data: {
        status: 'REPLIED',
        nextSendAt: null,
      },
    });

    // Record a Reply Event if Message exists
    const lastMessage = await this.prisma.message.findFirst({
      where: { campaignId, contactId: lead.contactId },
      orderBy: { stepNumber: 'desc' },
    });

    if (lastMessage) {
      await this.prisma.event.create({
        data: {
          type: 'Reply',
          messageId: lastMessage.id,
          rawPayload: { source: 'markLeadReplied', at: new Date().toISOString() },
        },
      });
    }

    // Refresh analytics snapshot
    try {
      await this.analyticsService.computeForCampaign(campaignId);
    } catch (err: any) {
      this.logger.warn(`Failed to recompute analytics: ${err?.message}`);
    }

    return updated;
  }

  // Helper for merge tags
  private renderMergeTags(templateText: string, contact: ContactEntry): string {
    return templateText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, rawKey: string) => {
      const lowerKey = rawKey.toLowerCase();
      const cleanKey = lowerKey.replace(/[^a-z0-9]/g, '');

      // First Name
      if (['first_name', 'firstname', 'fname', 'first', 'first-name', 'f_name'].includes(lowerKey) || cleanKey === 'firstname' || cleanKey === 'fname') {
        if (contact.firstName) return contact.firstName;
      }

      // Last Name
      if (['last_name', 'lastname', 'lname', 'last', 'last-name', 'l_name'].includes(lowerKey) || cleanKey === 'lastname' || cleanKey === 'lname') {
        if (contact.lastName) return contact.lastName;
      }

      // Email
      if (['email', 'email_address', 'mail', 'emailaddress', 'e-mail'].includes(lowerKey) || cleanKey === 'email' || cleanKey === 'emailaddress') {
        if (contact.email) return contact.email;
      }

      if (contact.attributes && typeof contact.attributes === 'object') {
        const attrs = contact.attributes as Record<string, any>;

        // Direct match
        if (attrs[rawKey] !== undefined && attrs[rawKey] !== null && String(attrs[rawKey]).trim() !== '') {
          return String(attrs[rawKey]);
        }
        if (attrs[lowerKey] !== undefined && attrs[lowerKey] !== null && String(attrs[lowerKey]).trim() !== '') {
          return String(attrs[lowerKey]);
        }

        // Job Title aliases
        const TITLE_ALIASES = ['title', 'job_title', 'jobtitle', 'job-title', 'job', 'role', 'position', 'designation', 'occupation'];
        if (TITLE_ALIASES.includes(lowerKey) || TITLE_ALIASES.map(a => a.replace(/[^a-z0-9]/g, '')).includes(cleanKey)) {
          for (const alias of ['title', 'job_title', 'jobTitle', 'jobtitle', 'job-title', 'role', 'position', 'designation', 'job', 'occupation']) {
            if (attrs[alias] !== undefined && attrs[alias] !== null && String(attrs[alias]).trim() !== '') {
              return String(attrs[alias]);
            }
          }
          const matchedTitleKey = Object.keys(attrs).find(k => {
            const kClean = k.toLowerCase().replace(/[^a-z0-9]/g, '');
            return ['title', 'jobtitle', 'job', 'role', 'position', 'designation'].includes(kClean);
          });
          if (matchedTitleKey && attrs[matchedTitleKey] !== undefined && attrs[matchedTitleKey] !== null) {
            return String(attrs[matchedTitleKey]);
          }
        }

        // Company Name aliases
        const COMPANY_ALIASES = ['company_name', 'company', 'companyname', 'company-name', 'organization', 'org', 'business', 'business_name', 'comp_name', 'compnay', 'compny'];
        if (COMPANY_ALIASES.includes(lowerKey) || COMPANY_ALIASES.map(a => a.replace(/[^a-z0-9]/g, '')).includes(cleanKey)) {
          for (const alias of ['company_name', 'companyName', 'company', 'companyname', 'organization', 'org', 'business', 'business_name', 'comp_name']) {
            if (attrs[alias] !== undefined && attrs[alias] !== null && String(attrs[alias]).trim() !== '') {
              return String(attrs[alias]);
            }
          }
          const matchedCompKey = Object.keys(attrs).find(k => {
            const kClean = k.toLowerCase().replace(/[^a-z0-9]/g, '');
            return ['companyname', 'company', 'organization', 'org', 'business', 'businessname'].includes(kClean);
          });
          if (matchedCompKey && attrs[matchedCompKey] !== undefined && attrs[matchedCompKey] !== null) {
            return String(attrs[matchedCompKey]);
          }
        }

        // Generic normalized match
        const foundKey = Object.keys(attrs).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanKey);
        if (foundKey && attrs[foundKey] !== undefined && attrs[foundKey] !== null && String(attrs[foundKey]).trim() !== '') {
          return String(attrs[foundKey]);
        }
      }
      return '';
    });
  }
}