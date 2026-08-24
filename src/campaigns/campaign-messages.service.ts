import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_PROVIDER } from '../email/email.provider';
import type { EmailProvider } from '../email/email.provider';
import { TrackingService } from '../tracking/tracking.service';

// ── Campaign status constants ─────────────────────────────────────────────────
export const CampaignStatus = {
  DRAFT:     'DRAFT',
  SENDING:   'SENDING',
  PAUSED:    'PAUSED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
} as const;

export type CampaignStatusType = (typeof CampaignStatus)[keyof typeof CampaignStatus];

// ── Return types ──────────────────────────────────────────────────────────────
export interface GenerateMessagesResult {
  created: number;
  suppressed: number;
  skipped: number; // contacts that already had a Message (idempotency)
}

export interface CampaignStatusResult {
  id: string;
  status: string;
}

import { AnalyticsService } from '../analytics/analytics.service';

@Injectable()
export class CampaignMessagesService {
  private readonly logger = new Logger(CampaignMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly trackingService: TrackingService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // generateMessages — idempotent
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Generate Message rows for every non-suppressed contact in the campaign's
   * audience. Idempotent: contacts that already have a Message row for this
   * campaign are skipped (counted in `skipped`). A DB unique index on
   * (campaignId, contactId) acts as an additional safety net.
   *
   * Suppression is enforced here at message-generation time, never at send time.
   */
  async generateMessages(campaignId: string): Promise<GenerateMessagesResult> {
    // Load campaign with audience, workspace, and contacts
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        audience: {
          include: {
            workspace: { select: { id: true } },
            contacts: { select: { id: true, email: true } },
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    const workspaceId = campaign.audience.workspace.id;
    const contacts = campaign.audience.contacts;

    if (contacts.length === 0) {
      this.logger.log(`Campaign ${campaignId}: no contacts in audience`);
      return { created: 0, suppressed: 0, skipped: 0 };
    }

    // ── 1. Suppression list (single bulk query) ───────────────────────────────
    const suppressionRows = await this.prisma.suppression.findMany({
      where: { workspaceId },
      select: { email: true },
    });
    const suppressedEmails = new Set(suppressionRows.map((r) => r.email.toLowerCase()));

    // ── 2. Already-existing Messages for this campaign ────────────────────────
    const existingMessages = await this.prisma.message.findMany({
      where: { campaignId },
      select: { contactId: true },
    });
    const existingContactIds = new Set(existingMessages.map((m) => m.contactId));

    // ── 3. Partition ──────────────────────────────────────────────────────────
    const toCreate: typeof contacts = [];
    let suppressed = 0;
    let skipped = 0;

    for (const contact of contacts) {
      if (suppressedEmails.has(contact.email.toLowerCase())) {
        suppressed++;
      } else if (existingContactIds.has(contact.id)) {
        skipped++; // already has a Message — idempotency skip
      } else {
        toCreate.push(contact);
      }
    }

    if (toCreate.length === 0) {
      this.logger.log(
        `Campaign ${campaignId}: created=0 suppressed=${suppressed} skipped=${skipped}`,
      );
      return { created: 0, suppressed, skipped };
    }

    // ── 4. Bulk create ────────────────────────────────────────────────────────
    // skipDuplicates is a DB-level safety net on top of our in-memory filter
    const result = await this.prisma.message.createMany({
      data: toCreate.map((c) => ({ campaignId, contactId: c.id })),
      skipDuplicates: true,
    });

    this.logger.log(
      `Campaign ${campaignId}: created=${result.count} suppressed=${suppressed} skipped=${skipped}`,
    );

    return { created: result.count, suppressed, skipped };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // dispatchCampaign — enqueues pending messages, checks status per-message
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue pending Message rows to BullMQ one-by-one, checking the campaign's
   * DB status before every message.
   *
   * If the status becomes PAUSED or CANCELLED mid-loop, enqueueing stops
   * immediately. Messages already in the BullMQ queue are unaffected.
   *
   * This method is fire-and-forget from the HTTP layer — the caller does NOT
   * await it. Errors are caught and logged without crashing the process.
   *
   * On PAUSED/CANCELLED stop: status is left as-is (PAUSED stays PAUSED).
   * On natural completion (all messages enqueued): status → COMPLETED.
   */
  async dispatchCampaign(campaignId: string): Promise<void> {
    // Fetch campaign with contact emails + optional template
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        audience: {
          include: { contacts: { select: { id: true, email: true, firstName: true, lastName: true, attributes: true } } },
        },
        template: { select: { html: true, subject: true } },
      },
    });

    if (!campaign) {
      this.logger.error(`dispatchCampaign: campaign ${campaignId} not found`);
      return;
    }

    // Resolve base HTML body: templateId wins over htmlBody
    const baseHtml = campaign.template?.html ?? campaign.htmlBody;
    if (!baseHtml) {
      this.logger.error(`dispatchCampaign: campaign ${campaignId} has no htmlBody and no templateId — aborting`);
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.CANCELLED },
      });
      return;
    }

    // Resolve subject: campaign.subject → template.subject → campaign.name
    const emailSubject = campaign.subject
      || campaign.template?.subject
      || campaign.name;

    // Build a contactId → contact map for rendering
    type ContactEntry = {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      attributes?: Record<string, any> | null;
    };
    const contactMap = new Map<string, ContactEntry>(
      campaign.audience.contacts.map((c) => [c.id, c as ContactEntry]),
    );

    // Fetch all Message rows not yet enqueued for this campaign
    const pendingMessages = await this.prisma.message.findMany({
      where: { campaignId, enqueuedAt: null },
      select: { id: true, contactId: true },
    });

    if (pendingMessages.length === 0) {
      this.logger.log(`Campaign ${campaignId}: no pending messages to dispatch`);
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.COMPLETED },
      });
      return;
    }

    this.logger.log(
      `Campaign ${campaignId}: dispatching ${pendingMessages.length} pending message(s)`,
    );

    let enqueued = 0;

    // Helper for rendering custom placeholders
    const renderMergeTags = (templateText: string, contact: ContactEntry): string => {
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
          const foundKey = Object.keys(attrs).find(k => k.toLowerCase().replace(/_/g, '') === noUnder);
          if (foundKey && attrs[foundKey] !== undefined && attrs[foundKey] !== null) return String(attrs[foundKey]);
        }
        return '';
      });
    };

    for (const message of pendingMessages) {
      // ── Re-read status from DB on every iteration ─────────────────────────
      const current = await this.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });

      if (
        !current ||
        current.status === CampaignStatus.PAUSED ||
        current.status === CampaignStatus.CANCELLED
      ) {
        this.logger.log(
          `Campaign ${campaignId}: dispatch stopped — status is ${current?.status ?? 'unknown'}`,
        );
        return; // leave status as PAUSED/CANCELLED; do not update to COMPLETED
      }

      const contact = contactMap.get(message.contactId);
      if (!contact) {
        this.logger.warn(
          `Campaign ${campaignId}: contact ${message.contactId} not found in audience map — skipping`,
        );
        continue;
      }

      // ── Render per-contact HTML & Subject ──────────────────────────────────
      const msgId   = message.id;
      const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

      // 1. Substitute placeholders (standard + custom attributes)
      let html = renderMergeTags(baseHtml, contact);
      const personalSubject = renderMergeTags(emailSubject, contact);

      // 2. Append unsubscribe footer (before tracking wrap)
      const unsubToken  = this.trackingService.generateToken(msgId);
      const unsubUrl    = `${baseUrl}/t/unsub/${unsubToken}`;
      const unsubFooter = `
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;text-align:center;font-size:12px;color:#888;">
  <p>You received this email because you are on our mailing list.<br>
  <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></p>
</div>`;
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${unsubFooter}</body>`);
      } else {
        html += unsubFooter;
      }

      // 3. Inject tracking pixel + wrap links
      try {
        await this.trackingService.saveToken(msgId, unsubToken);
        html = this.trackingService.wrapHtml(html, unsubToken, baseUrl);
      } catch (trackErr: any) {
        this.logger.warn(`Tracking setup failed (continuing): ${trackErr?.message ?? trackErr}`);
      }

      // Resolve custom from and reply-to
      const defaultFromAddress = process.env.AWS_SES_FROM_ADDRESS || 'noreply@digireps.org';
      const senderEmail = (campaign as any).fromEmail?.trim() || defaultFromAddress;
      const senderFrom = (campaign as any).fromName?.trim()
        ? `"${(campaign as any).fromName.trim()}" <${senderEmail}>`
        : senderEmail;

      const replyTo = (campaign as any).replyTo?.trim()
        ? [(campaign as any).replyTo.trim()]
        : [senderEmail];

      const result = await this.emailProvider.send({
        to: contact.email as string,
        subject: personalSubject,
        html,
        from: senderFrom,
        replyTo,
      });
      this.logger.log(`Sent message ${msgId} to ${contact.email} from ${senderFrom} — providerId: ${result.providerId}`);

      // Update Message with SES MessageId + mark enqueued
      await this.prisma.message.update({
        where: { id: msgId },
        data: { enqueuedAt: new Date() },
      });

      // Try to update Message.id to SES's providerId (best-effort)
      if (result.providerId && result.providerId !== msgId) {
        try {
          await this.prisma.message.update({
            where: { id: msgId },
            data: { id: result.providerId },
          });
        } catch (idErr: any) {
          this.logger.warn(`Could not update Message ID to providerId: ${idErr?.message}`);
        }
      }

      enqueued++;
    }

    // All pending messages dispatched — mark campaign COMPLETED
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.COMPLETED },
    });

    // Auto-compute fresh analytics snapshot immediately
    try {
      await this.analyticsService.computeForCampaign(campaignId);
    } catch (computeErr: any) {
      this.logger.warn(`Could not compute initial snapshot for campaign ${campaignId}: ${computeErr?.message}`);
    }

    this.logger.log(`Campaign ${campaignId}: dispatch complete — enqueued=${enqueued}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Status transitions
  // ─────────────────────────────────────────────────────────────────────────────

  /** Start sending: set status → SENDING, fire-and-forget dispatch. */
  async startSending(campaignId: string): Promise<CampaignStatusResult> {
    await this.assertExists(campaignId);
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.SENDING },
    });

    // Fire-and-forget — do NOT await so HTTP response returns immediately
    this.dispatchCampaign(campaignId).catch((err) =>
      this.logger.error(`Campaign ${campaignId} dispatch error: ${err?.message ?? err}`),
    );

    return { id: campaignId, status: CampaignStatus.SENDING };
  }

  /** Pause: stop future enqueueing. Messages already in BullMQ are unaffected. */
  async pauseCampaign(campaignId: string): Promise<CampaignStatusResult> {
    const campaign = await this.assertExists(campaignId);

    if (campaign.status !== CampaignStatus.SENDING) {
      throw new ConflictException(
        `Campaign ${campaignId} cannot be paused — current status is "${campaign.status}" (must be SENDING)`,
      );
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.PAUSED },
    });

    return { id: campaignId, status: CampaignStatus.PAUSED };
  }

  /** Resume: set status → SENDING, re-trigger dispatch for remaining pending messages. */
  async resumeCampaign(campaignId: string): Promise<CampaignStatusResult> {
    const campaign = await this.assertExists(campaignId);

    if (campaign.status !== CampaignStatus.PAUSED) {
      throw new ConflictException(
        `Campaign ${campaignId} cannot be resumed — current status is "${campaign.status}" (must be PAUSED)`,
      );
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.SENDING },
    });

    this.dispatchCampaign(campaignId).catch((err) =>
      this.logger.error(`Campaign ${campaignId} resume dispatch error: ${err?.message ?? err}`),
    );

    return { id: campaignId, status: CampaignStatus.SENDING };
  }

  /** Cancel: stop future generation/enqueueing. Already-queued messages still send. */
  async cancelCampaign(campaignId: string): Promise<CampaignStatusResult> {
    const campaign = await this.assertExists(campaignId);

    if (campaign.status === CampaignStatus.CANCELLED) {
      throw new ConflictException(`Campaign ${campaignId} is already cancelled`);
    }
    if (campaign.status === CampaignStatus.COMPLETED) {
      throw new ConflictException(
        `Campaign ${campaignId} is already completed and cannot be cancelled`,
      );
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.CANCELLED },
    });

    return { id: campaignId, status: CampaignStatus.CANCELLED };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async assertExists(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true, name: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }
    return campaign;
  }
}
