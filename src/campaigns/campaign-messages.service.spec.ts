import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CampaignMessagesService,
  CampaignStatus,
} from './campaign-messages.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockCampaignFindUnique: jest.Mock = jest.fn();
const mockSuppressionFindMany: jest.Mock = jest.fn();
const mockMessageFindMany: jest.Mock = jest.fn();
const mockMessageCreateMany: jest.Mock = jest.fn();
const mockMessageUpdate: jest.Mock = jest.fn();
const mockCampaignUpdate: jest.Mock = jest.fn();

const mockPrisma = {
  campaign:    { findUnique: mockCampaignFindUnique, update: mockCampaignUpdate },
  suppression: { findMany: mockSuppressionFindMany },
  message:     { findMany: mockMessageFindMany, createMany: mockMessageCreateMany, update: mockMessageUpdate },
};

const mockQueueAdd: jest.Mock = jest.fn();
const mockQueue = { add: mockQueueAdd };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const workspaceId = 'ws-1';
const campaignId  = 'camp-1';

const contacts = [
  { id: 'c-1', email: 'alice@example.com' },
  { id: 'c-2', email: 'bob@example.com' },
  { id: 'c-3', email: 'charlie@example.com' },
];

function makeCampaign(status: string = CampaignStatus.DRAFT, overrideContacts = contacts): any {
  return {
    id: campaignId,
    name: 'Test Campaign',
    status,
    audience: {
      id: 'aud-1',
      workspace: { id: workspaceId },
      contacts: overrideContacts,
    },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('CampaignMessagesService', () => {
  let service: CampaignMessagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignMessagesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken('email'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<CampaignMessagesService>(CampaignMessagesService);
    jest.clearAllMocks();
  });

  // ── generateMessages ──────────────────────────────────────────────────────

  describe('generateMessages', () => {
    it('never creates a Message for a suppressed contact', async () => {
      mockCampaignFindUnique.mockResolvedValue(makeCampaign());
      mockSuppressionFindMany.mockResolvedValue([{ email: 'charlie@example.com' }]);
      mockMessageFindMany.mockResolvedValue([]); // no existing messages
      mockMessageCreateMany.mockResolvedValue({ count: 2 });

      const result = await service.generateMessages(campaignId);

      expect(result.suppressed).toBe(1);
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);

      const callData = mockMessageCreateMany.mock.calls[0][0].data as Array<{ contactId: string }>;
      expect(callData.map((d) => d.contactId)).not.toContain('c-3');
    });

    // ── IDEMPOTENCY TEST ──────────────────────────────────────────────────────

    it('skips contacts that already have a Message for this campaign (idempotency)', async () => {
      mockCampaignFindUnique.mockResolvedValue(makeCampaign());
      mockSuppressionFindMany.mockResolvedValue([]);
      // alice and bob already have Messages
      mockMessageFindMany.mockResolvedValue([
        { contactId: 'c-1' },
        { contactId: 'c-2' },
      ]);
      mockMessageCreateMany.mockResolvedValue({ count: 1 });

      const result = await service.generateMessages(campaignId);

      expect(result.skipped).toBe(2); // alice + bob skipped
      expect(result.created).toBe(1); // only charlie created
      expect(result.suppressed).toBe(0);

      const callData = mockMessageCreateMany.mock.calls[0][0].data as Array<{ contactId: string }>;
      expect(callData).toHaveLength(1);
      expect(callData[0].contactId).toBe('c-3');
    });

    it('returns { created:0, suppressed:0, skipped:0 } when audience is empty', async () => {
      mockCampaignFindUnique.mockResolvedValue(makeCampaign(CampaignStatus.DRAFT, []));

      const result = await service.generateMessages(campaignId);

      expect(result).toEqual({ created: 0, suppressed: 0, skipped: 0 });
      expect(mockMessageCreateMany).not.toHaveBeenCalled();
    });

    it('returns zero created when all contacts already have Messages', async () => {
      mockCampaignFindUnique.mockResolvedValue(makeCampaign());
      mockSuppressionFindMany.mockResolvedValue([]);
      mockMessageFindMany.mockResolvedValue(contacts.map((c) => ({ contactId: c.id })));

      const result = await service.generateMessages(campaignId);

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(3);
      expect(mockMessageCreateMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for unknown campaign', async () => {
      mockCampaignFindUnique.mockResolvedValue(null);
      await expect(service.generateMessages('bad')).rejects.toThrow(NotFoundException);
    });
  });

  // ── dispatchCampaign ──────────────────────────────────────────────────────

  describe('dispatchCampaign', () => {
    const pendingMessages = contacts.map((c) => ({ id: `msg-${c.id}`, contactId: c.id }));

    it('enqueues all pending messages and marks campaign COMPLETED', async () => {
      mockCampaignFindUnique
        .mockResolvedValueOnce(makeCampaign(CampaignStatus.SENDING)) // initial load
        .mockResolvedValue({ status: CampaignStatus.SENDING });       // per-iteration check

      mockMessageFindMany.mockResolvedValue(pendingMessages);
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });
      mockMessageUpdate.mockResolvedValue({});
      mockCampaignUpdate.mockResolvedValue({});

      await service.dispatchCampaign(campaignId);

      expect(mockQueueAdd).toHaveBeenCalledTimes(3);
      expect(mockMessageUpdate).toHaveBeenCalledTimes(3);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        where: { id: campaignId },
        data: { status: CampaignStatus.COMPLETED },
      });
    });

    it('skips already-enqueued messages (enqueuedAt filter passed to findMany)', async () => {
      mockCampaignFindUnique
        .mockResolvedValueOnce(makeCampaign(CampaignStatus.SENDING))
        .mockResolvedValue({ status: CampaignStatus.SENDING });

      // Only 1 pending message (the other 2 were already enqueued)
      mockMessageFindMany.mockResolvedValue([pendingMessages[0]]);
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });
      mockMessageUpdate.mockResolvedValue({});
      mockCampaignUpdate.mockResolvedValue({});

      await service.dispatchCampaign(campaignId);

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockMessageFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { campaignId, enqueuedAt: null } }),
      );
    });

    // ── KEY TEST: pause mid-send ──────────────────────────────────────────────

    it('stops enqueueing immediately when campaign is paused mid-send', async () => {
      mockCampaignFindUnique
        .mockResolvedValueOnce(makeCampaign(CampaignStatus.SENDING)) // initial campaign load
        .mockResolvedValueOnce({ status: CampaignStatus.SENDING })   // 1st iteration → continue
        .mockResolvedValueOnce({ status: CampaignStatus.PAUSED })    // 2nd iteration → STOP
        .mockResolvedValue({ status: CampaignStatus.PAUSED });        // 3rd (never reached)

      mockMessageFindMany.mockResolvedValue(pendingMessages); // 3 pending
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });
      mockMessageUpdate.mockResolvedValue({});

      await service.dispatchCampaign(campaignId);

      // Only the FIRST message was enqueued before the pause was detected
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({ messageId: 'msg-c-1' }),
      );

      // Campaign status must NOT be updated to COMPLETED
      const completedCall = mockCampaignUpdate.mock.calls.find(
        (call) => call[0]?.data?.status === CampaignStatus.COMPLETED,
      );
      expect(completedCall).toBeUndefined();

      // No new Messages were created after the pause (createMany never called in dispatch)
      expect(mockMessageCreateMany).not.toHaveBeenCalled();
    });

    it('stops enqueueing immediately when campaign is cancelled mid-send', async () => {
      mockCampaignFindUnique
        .mockResolvedValueOnce(makeCampaign(CampaignStatus.SENDING))
        .mockResolvedValueOnce({ status: CampaignStatus.SENDING })
        .mockResolvedValueOnce({ status: CampaignStatus.CANCELLED });

      mockMessageFindMany.mockResolvedValue(pendingMessages);
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });
      mockMessageUpdate.mockResolvedValue({});

      await service.dispatchCampaign(campaignId);

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockCampaignUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: CampaignStatus.COMPLETED } }),
      );
    });

    it('marks COMPLETED immediately when no pending messages exist', async () => {
      mockCampaignFindUnique.mockResolvedValueOnce(makeCampaign(CampaignStatus.SENDING));
      mockMessageFindMany.mockResolvedValue([]);
      mockCampaignUpdate.mockResolvedValue({});

      await service.dispatchCampaign(campaignId);

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        where: { id: campaignId },
        data: { status: CampaignStatus.COMPLETED },
      });
    });
  });

  // ── pauseCampaign ─────────────────────────────────────────────────────────

  describe('pauseCampaign', () => {
    it('transitions SENDING → PAUSED', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.SENDING, name: 'x' });
      mockCampaignUpdate.mockResolvedValue({});

      const result = await service.pauseCampaign(campaignId);

      expect(result.status).toBe(CampaignStatus.PAUSED);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        where: { id: campaignId },
        data: { status: CampaignStatus.PAUSED },
      });
    });

    it('throws ConflictException when campaign is not SENDING', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.DRAFT, name: 'x' });
      await expect(service.pauseCampaign(campaignId)).rejects.toThrow(ConflictException);
    });
  });

  // ── resumeCampaign ────────────────────────────────────────────────────────

  describe('resumeCampaign', () => {
    it('transitions PAUSED → SENDING and triggers dispatch', async () => {
      mockCampaignFindUnique
        .mockResolvedValueOnce({ id: campaignId, status: CampaignStatus.PAUSED, name: 'x' }) // assertExists
        .mockResolvedValueOnce(makeCampaign(CampaignStatus.SENDING))  // dispatchCampaign initial load
        .mockResolvedValue({ status: CampaignStatus.SENDING });        // per-iteration

      mockCampaignUpdate.mockResolvedValue({});
      mockMessageFindMany.mockResolvedValue([]);

      const result = await service.resumeCampaign(campaignId);

      expect(result.status).toBe(CampaignStatus.SENDING);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        where: { id: campaignId },
        data: { status: CampaignStatus.SENDING },
      });
    });

    it('throws ConflictException when campaign is not PAUSED', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.CANCELLED, name: 'x' });
      await expect(service.resumeCampaign(campaignId)).rejects.toThrow(ConflictException);
    });
  });

  // ── cancelCampaign ────────────────────────────────────────────────────────

  describe('cancelCampaign', () => {
    it('transitions SENDING → CANCELLED', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.SENDING, name: 'x' });
      mockCampaignUpdate.mockResolvedValue({});

      const result = await service.cancelCampaign(campaignId);

      expect(result.status).toBe(CampaignStatus.CANCELLED);
    });

    it('transitions PAUSED → CANCELLED', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.PAUSED, name: 'x' });
      mockCampaignUpdate.mockResolvedValue({});

      const result = await service.cancelCampaign(campaignId);

      expect(result.status).toBe(CampaignStatus.CANCELLED);
    });

    it('throws ConflictException when already CANCELLED', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.CANCELLED, name: 'x' });
      await expect(service.cancelCampaign(campaignId)).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when already COMPLETED', async () => {
      mockCampaignFindUnique.mockResolvedValue({ id: campaignId, status: CampaignStatus.COMPLETED, name: 'x' });
      await expect(service.cancelCampaign(campaignId)).rejects.toThrow(ConflictException);
    });
  });
});
