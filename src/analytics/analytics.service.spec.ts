import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Mock factories ─────────────────────────────────────────────────────────────

const mockCampaignFindUnique: jest.Mock = jest.fn();
const mockCampaignFindMany:   jest.Mock = jest.fn();
const mockSnapshotFindUnique: jest.Mock = jest.fn();
const mockSnapshotUpsert:     jest.Mock = jest.fn();
const mockQueryRaw:           jest.Mock = jest.fn();

const mockPrisma = {
  campaign:          { findUnique: mockCampaignFindUnique, findMany: mockCampaignFindMany },
  analyticsSnapshot: { findUnique: mockSnapshotFindUnique, upsert: mockSnapshotUpsert },
  client:            { $queryRaw: mockQueryRaw },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const campaignId = 'camp-1';

// 100 sent, 95 delivered, 40 opens, 12 clicks, 3 bounces, 1 complaint
const mockEventRows = [
  { type: 'Send',      count: BigInt(100) },
  { type: 'Delivery',  count: BigInt(95)  },
  { type: 'Open',      count: BigInt(40)  },
  { type: 'Click',     count: BigInt(12)  },
  { type: 'Bounce',    count: BigInt(3)   },
  { type: 'Complaint', count: BigInt(1)   },
];

const freshSnapshot = {
  campaignId,
  sent: 100, delivered: 95, opened: 40, clicked: 12, bounced: 3, complained: 1,
  computedAt: new Date(), // just now — not stale
};

const staleSnapshot = {
  ...freshSnapshot,
  computedAt: new Date(Date.now() - 31 * 60 * 1000), // 31 minutes ago → stale
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    jest.clearAllMocks();
  });

  // ── getSnapshot ─────────────────────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('returns snapshot with correct values and computed rates', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId });
      mockSnapshotFindUnique.mockResolvedValue(freshSnapshot);

      const result = await service.getSnapshot(campaignId);

      expect(result.campaignId).toBe(campaignId);
      expect(result.sent).toBe(100);
      expect(result.delivered).toBe(95);
      expect(result.opened).toBe(40);
      expect(result.clicked).toBe(12);
      expect(result.bounced).toBe(3);
      expect(result.complained).toBe(1);

      // Rates computed from sent=100
      expect(result.rates.deliveryRate).toBe(0.95);
      expect(result.rates.openRate).toBe(0.40);
      expect(result.rates.clickRate).toBe(0.12);
      expect(result.rates.bounceRate).toBe(0.03);
      expect(result.rates.complaintRate).toBe(0.01);
    });

    it('staleWarning is false when snapshot is fresh', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId });
      mockSnapshotFindUnique.mockResolvedValue(freshSnapshot);

      const result = await service.getSnapshot(campaignId);

      expect(result.staleWarning).toBe(false);
    });

    it('staleWarning is true when snapshot is older than 30 minutes', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId });
      mockSnapshotFindUnique.mockResolvedValue(staleSnapshot);

      const result = await service.getSnapshot(campaignId);

      expect(result.staleWarning).toBe(true);
    });

    it('returns zero counts and staleWarning=true when no snapshot exists yet', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId });
      mockSnapshotFindUnique.mockResolvedValue(null);

      const result = await service.getSnapshot(campaignId);

      expect(result.sent).toBe(0);
      expect(result.delivered).toBe(0);
      expect(result.opened).toBe(0);
      expect(result.staleWarning).toBe(true);
    });

    it('never calls $queryRaw — reads only from AnalyticsSnapshot', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId });
      mockSnapshotFindUnique.mockResolvedValue(freshSnapshot);

      await service.getSnapshot(campaignId);

      // Dashboard must NEVER touch the Event table
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for unknown campaign', async () => {
      mockCampaignFindUnique.mockResolvedValue(null);

      await expect(service.getSnapshot('bad-id')).rejects.toThrow(NotFoundException);
    });

    // ── Divide-by-zero guard ──────────────────────────────────────────────────

    it('returns 0 for all rates when sent=0 (divide-by-zero guard)', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId });
      mockSnapshotFindUnique.mockResolvedValue({
        ...freshSnapshot,
        sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0,
      });

      const result = await service.getSnapshot(campaignId);

      expect(result.rates.deliveryRate).toBe(0);
      expect(result.rates.openRate).toBe(0);
      expect(result.rates.clickRate).toBe(0);
      expect(result.rates.bounceRate).toBe(0);
      expect(result.rates.complaintRate).toBe(0);
    });
  });

  // ── computeForCampaign ──────────────────────────────────────────────────────

  describe('computeForCampaign', () => {
    it('issues a single $queryRaw GROUP BY call (not one per event type)', async () => {
      mockQueryRaw.mockResolvedValue(mockEventRows);
      mockSnapshotUpsert.mockResolvedValue({});

      await service.computeForCampaign(campaignId);

      // Exactly one aggregation query
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it('maps event rows to correct snapshot counts and upserts', async () => {
      mockQueryRaw.mockResolvedValue(mockEventRows);
      mockSnapshotUpsert.mockResolvedValue({});

      await service.computeForCampaign(campaignId);

      expect(mockSnapshotUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where:  { campaignId },
          create: expect.objectContaining({
            sent: 100, delivered: 95, opened: 40, clicked: 12, bounced: 3, complained: 1,
          }),
          update: expect.objectContaining({
            sent: 100, delivered: 95, opened: 40, clicked: 12, bounced: 3, complained: 1,
          }),
        }),
      );
    });

    it('handles BigInt counts from $queryRaw (converts to Number)', async () => {
      mockQueryRaw.mockResolvedValue([{ type: 'Send', count: BigInt(9999999) }]);
      mockSnapshotUpsert.mockResolvedValue({});

      const result = await service.computeForCampaign(campaignId);

      expect(result.sent).toBe(9999999);
      expect(typeof result.sent).toBe('number'); // NOT BigInt
    });

    it('ignores unknown event types gracefully', async () => {
      mockQueryRaw.mockResolvedValue([
        { type: 'Send',    count: BigInt(5) },
        { type: 'Unknown', count: BigInt(99) }, // unknown — must not throw
      ]);
      mockSnapshotUpsert.mockResolvedValue({});

      const result = await service.computeForCampaign(campaignId);

      expect(result.sent).toBe(5);
    });

    it('returns a result with computed rates', async () => {
      mockQueryRaw.mockResolvedValue(mockEventRows);
      mockSnapshotUpsert.mockResolvedValue({});

      const result = await service.computeForCampaign(campaignId);

      expect(result.rates.deliveryRate).toBe(0.95);
      expect(result.rates.openRate).toBe(0.40);
    });

    it('returns staleWarning=false immediately after compute', async () => {
      mockQueryRaw.mockResolvedValue(mockEventRows);
      mockSnapshotUpsert.mockResolvedValue({});

      const result = await service.computeForCampaign(campaignId);

      expect(result.staleWarning).toBe(false);
    });
  });

  // ── computeAll ──────────────────────────────────────────────────────────────

  describe('computeAll', () => {
    it('only processes campaigns with status != DRAFT', async () => {
      mockCampaignFindMany.mockResolvedValue([
        { id: 'camp-1' },
        { id: 'camp-2' },
      ]);
      mockQueryRaw.mockResolvedValue([]);
      mockSnapshotUpsert.mockResolvedValue({});

      const result = await service.computeAll();

      expect(mockCampaignFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: { not: 'DRAFT' } } }),
      );
      expect(result.processed).toBe(2);
    });

    it('continues processing remaining campaigns if one fails', async () => {
      mockCampaignFindMany.mockResolvedValue([
        { id: 'camp-good' },
        { id: 'camp-bad'  },
        { id: 'camp-ok'   },
      ]);

      // camp-bad throws, camp-good and camp-ok succeed
      mockQueryRaw
        .mockResolvedValueOnce([])                         // camp-good
        .mockRejectedValueOnce(new Error('DB error'))      // camp-bad
        .mockResolvedValueOnce([]);                        // camp-ok

      mockSnapshotUpsert.mockResolvedValue({});

      // Must not throw
      await expect(service.computeAll()).resolves.not.toThrow();

      const result = await service.computeAll();
      expect(result.processed).toBe(3); // all 3 attempted
    });

    it('returns processed count and durationMs', async () => {
      mockCampaignFindMany.mockResolvedValue([{ id: 'camp-1' }]);
      mockQueryRaw.mockResolvedValue([]);
      mockSnapshotUpsert.mockResolvedValue({});

      const result = await service.computeAll();

      expect(typeof result.processed).toBe('number');
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns processed=0 when no campaigns need aggregation', async () => {
      mockCampaignFindMany.mockResolvedValue([]);

      const result = await service.computeAll();

      expect(result.processed).toBe(0);
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });
  });
});
