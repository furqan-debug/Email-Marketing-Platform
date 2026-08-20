import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class CampaignMessagesService {
  private readonly logger = new Logger(CampaignMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('email') private readonly emailQueue: Queue,
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
    // Fetch campaign with contact emails (needed for enqueueing)
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        audience: { include: { contacts: { select: { id: true, email: true } } } },
      },
    });

    if (!campaign) {
      this.logger.error(`dispatchCampaign: campaign ${campaignId} not found`);
      return;
    }

    // Build a contactId → email map for quick lookup
    const contactMap = new Map(
      campaign.audience.contacts.map((c) => [c.id, c.email]),
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

      const email = contactMap.get(message.contactId);
      if (!email) {
        this.logger.warn(
          `Campaign ${campaignId}: contact ${message.contactId} not found in audience map — skipping`,
        );
        continue;
      }

      // ── Enqueue to BullMQ ─────────────────────────────────────────────────
      await this.emailQueue.add('send', {
        to: email,
        subject: campaign.name,
        html: `<p>Campaign: ${campaign.name}</p>`,
        messageId: message.id,
      });

      // ── Mark as enqueued in DB ────────────────────────────────────────────
      await this.prisma.message.update({
        where: { id: message.id },
        data: { enqueuedAt: new Date() },
      });

      enqueued++;
    }

    // All pending messages dispatched — mark campaign COMPLETED
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.COMPLETED },
    });

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
