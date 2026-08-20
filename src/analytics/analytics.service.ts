import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ── Metric keys that map to Event.type values ─────────────────────────────────
const EVENT_TYPE_MAP: Record<string, keyof SnapshotCounts> = {
  Send:      'sent',
  Delivery:  'delivered',
  Open:      'opened',
  Click:     'clicked',
  Bounce:    'bounced',
  Complaint: 'complained',
};

interface SnapshotCounts {
  sent:       number;
  delivered:  number;
  opened:     number;
  clicked:    number;
  bounced:    number;
  complained: number;
}

export interface AnalyticsRates {
  deliveryRate:   number;
  openRate:       number;
  clickRate:      number;
  bounceRate:     number;
  complaintRate:  number;
}

export interface AnalyticsResult extends SnapshotCounts {
  campaignId:  string;
  rates:       AnalyticsRates;
  computedAt:  Date;
  staleWarning: boolean; // true if computedAt > STALE_THRESHOLD_MS ago
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Read path — dashboard never queries Event directly
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Returns the latest AnalyticsSnapshot for a campaign, enriched with
   * computed rates and a stale-data warning flag.
   *
   * If the campaign exists but no snapshot has been computed yet, returns
   * zero-value counts (the job hasn't run for this campaign yet).
   *
   * Never queries the Event table — reads only from AnalyticsSnapshot.
   */
  async getSnapshot(campaignId: string): Promise<AnalyticsResult> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    const snapshot = await this.prisma.analyticsSnapshot.findUnique({
      where: { campaignId },
    });

    const counts: SnapshotCounts = snapshot
      ? {
          sent:       snapshot.sent,
          delivered:  snapshot.delivered,
          opened:     snapshot.opened,
          clicked:    snapshot.clicked,
          bounced:    snapshot.bounced,
          complained: snapshot.complained,
        }
      : { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 };

    const computedAt = snapshot?.computedAt ?? new Date(0);
    const staleWarning = !snapshot || (Date.now() - computedAt.getTime() > STALE_THRESHOLD_MS);

    return {
      campaignId,
      ...counts,
      rates: this.computeRates(counts),
      computedAt,
      staleWarning,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Write path — called by scheduler + on-demand endpoint
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Aggregates all Event rows for a single campaign into a snapshot.
   *
   * Uses a single GROUP BY query against Event JOIN Message — one DB
   * round-trip regardless of how many events exist. Upserts on campaignId
   * so re-running is safe.
   */
  async computeForCampaign(campaignId: string): Promise<AnalyticsResult> {
    // Single aggregation query: COUNT events by type for this campaign
    const rows = await this.prisma.client.$queryRaw<Array<{ type: string; count: bigint }>>`
      SELECT e.type, COUNT(*) AS count
      FROM "Event" e
      INNER JOIN "Message" m ON m.id = e."messageId"
      WHERE m."campaignId" = ${campaignId}
      GROUP BY e.type
    `;

    // Map results to named counts
    const counts: SnapshotCounts = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 };
    for (const row of rows) {
      const field = EVENT_TYPE_MAP[row.type];
      if (field) {
        counts[field] = Number(row.count);
      }
    }

    const computedAt = new Date();

    // Upsert — safe to run multiple times
    await this.prisma.analyticsSnapshot.upsert({
      where:  { campaignId },
      create: { campaignId, ...counts, computedAt },
      update: { ...counts, computedAt },
    });

    this.logger.log(
      `Snapshot computed for campaign ${campaignId}: sent=${counts.sent} delivered=${counts.delivered} ` +
      `opened=${counts.opened} clicked=${counts.clicked} bounced=${counts.bounced} complained=${counts.complained}`,
    );

    return {
      campaignId,
      ...counts,
      rates: this.computeRates(counts),
      computedAt,
      staleWarning: false,
    };
  }

  /**
   * Runs computeForCampaign for every non-DRAFT campaign sequentially.
   * Called by AnalyticsScheduler on the configured cron schedule.
   *
   * Sequential (not concurrent) to keep DB load predictable.
   */
  async computeAll(): Promise<{ processed: number; durationMs: number }> {
    const start = Date.now();

    const campaigns = await this.prisma.campaign.findMany({
      where: { status: { not: 'DRAFT' } },
      select: { id: true },
    });

    this.logger.log(`Analytics job starting — ${campaigns.length} campaign(s) to process`);

    for (const { id } of campaigns) {
      try {
        await this.computeForCampaign(id);
      } catch (err: any) {
        // Log and continue — one failing campaign must not abort the whole job
        this.logger.error(`Failed to compute snapshot for campaign ${id}: ${err?.message ?? err}`);
      }
    }

    const durationMs = Date.now() - start;
    this.logger.log(`Analytics job complete — processed=${campaigns.length} duration=${durationMs}ms`);

    return { processed: campaigns.length, durationMs };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private computeRates(counts: SnapshotCounts): AnalyticsRates {
    const base = counts.sent || 1; // guard against divide-by-zero; if sent=0 rates will all be 0
    const safe = (n: number) => counts.sent === 0 ? 0 : Math.round((n / base) * 10000) / 10000;

    return {
      deliveryRate:  safe(counts.delivered),
      openRate:      safe(counts.opened),
      clickRate:     safe(counts.clicked),
      bounceRate:    safe(counts.bounced),
      complaintRate: safe(counts.complained),
    };
  }
}
