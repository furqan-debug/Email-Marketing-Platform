import { Test, TestingModule } from '@nestjs/testing';
import { CampaignMessagesService } from './campaign-messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

// ── Mock PrismaService ────────────────────────────────────────────────────────
const mockCampaignFindUnique = jest.fn();
const mockSuppressionFindMany = jest.fn();
const mockMessageCreateMany = jest.fn();

const mockPrisma = {
  campaign: {
    findUnique: mockCampaignFindUnique,
  },
  suppression: {
    findMany: mockSuppressionFindMany,
  },
  message: {
    createMany: mockMessageCreateMany,
  },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const workspaceId = 'ws-test';
const campaignId  = 'camp-test';
const audienceId  = 'aud-test';

const contacts = [
  { id: 'c-1', email: 'alice@example.com' },
  { id: 'c-2', email: 'bob@example.com' },
  { id: 'c-3', email: 'suppressed@example.com' },
];

function campaignFixture(overrideContacts = contacts) {
  return {
    id: campaignId,
    audience: {
      id: audienceId,
      workspace: { id: workspaceId },
      contacts: overrideContacts,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CampaignMessagesService', () => {
  let service: CampaignMessagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignMessagesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CampaignMessagesService>(CampaignMessagesService);
    jest.clearAllMocks();
  });

  // ── KEY TEST: suppression enforcement ────────────────────────────────────────

  it('never creates a Message for a suppressed contact', async () => {
    // Audience has 3 contacts; suppressed@example.com is on the suppression list
    mockCampaignFindUnique.mockResolvedValue(campaignFixture());
    mockSuppressionFindMany.mockResolvedValue([
      { email: 'suppressed@example.com' },
    ]);
    mockMessageCreateMany.mockResolvedValue({ count: 2 });

    const result = await service.generateMessages(campaignId);

    // Exactly 2 messages created (alice + bob), 1 suppressed
    expect(result.created).toBe(2);
    expect(result.suppressed).toBe(1);

    // createMany must NOT include the suppressed contact
    expect(mockMessageCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ contactId: 'c-1' }),
        expect.objectContaining({ contactId: 'c-2' }),
      ]),
      skipDuplicates: true,
    });

    const callData = mockMessageCreateMany.mock.calls[0][0].data as Array<{ contactId: string }>;
    const contactIds = callData.map((d) => d.contactId);
    expect(contactIds).not.toContain('c-3'); // suppressed contact MUST NOT appear
  });

  it('suppression check is case-insensitive (email stored uppercase in DB)', async () => {
    // Suppression row stored in mixed case — service must normalise before comparing
    mockCampaignFindUnique.mockResolvedValue(campaignFixture([
      { id: 'c-1', email: 'Alice@Example.COM' },
    ]));
    mockSuppressionFindMany.mockResolvedValue([
      { email: 'alice@example.com' }, // lowercase in suppression table
    ]);
    mockMessageCreateMany.mockResolvedValue({ count: 0 });

    const result = await service.generateMessages(campaignId);

    expect(result.suppressed).toBe(1);
    expect(result.created).toBe(0);
    expect(mockMessageCreateMany).not.toHaveBeenCalled();
  });

  it('fetches suppression list in a single query (not per-contact)', async () => {
    mockCampaignFindUnique.mockResolvedValue(campaignFixture());
    mockSuppressionFindMany.mockResolvedValue([]);
    mockMessageCreateMany.mockResolvedValue({ count: 3 });

    await service.generateMessages(campaignId);

    // Only ONE call to suppression.findMany regardless of contact count
    expect(mockSuppressionFindMany).toHaveBeenCalledTimes(1);
    expect(mockSuppressionFindMany).toHaveBeenCalledWith({
      where: { workspaceId },
      select: { email: true },
    });
  });

  it('returns { created: 0, suppressed: 0 } when audience has no contacts', async () => {
    mockCampaignFindUnique.mockResolvedValue(campaignFixture([]));

    const result = await service.generateMessages(campaignId);

    expect(result).toEqual({ created: 0, suppressed: 0 });
    expect(mockSuppressionFindMany).not.toHaveBeenCalled();
    expect(mockMessageCreateMany).not.toHaveBeenCalled();
  });

  it('returns { created: 0, suppressed: N } when ALL contacts are suppressed', async () => {
    mockCampaignFindUnique.mockResolvedValue(campaignFixture());
    mockSuppressionFindMany.mockResolvedValue(
      contacts.map((c) => ({ email: c.email })),
    );

    const result = await service.generateMessages(campaignId);

    expect(result.created).toBe(0);
    expect(result.suppressed).toBe(3);
    expect(mockMessageCreateMany).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when campaign does not exist', async () => {
    mockCampaignFindUnique.mockResolvedValue(null);

    await expect(service.generateMessages('bad-id')).rejects.toThrow(NotFoundException);
  });

  it('creates messages for all contacts when suppression list is empty', async () => {
    mockCampaignFindUnique.mockResolvedValue(campaignFixture());
    mockSuppressionFindMany.mockResolvedValue([]); // no suppressions
    mockMessageCreateMany.mockResolvedValue({ count: 3 });

    const result = await service.generateMessages(campaignId);

    expect(result.created).toBe(3);
    expect(result.suppressed).toBe(0);
    expect(mockMessageCreateMany).toHaveBeenCalledWith({
      data: contacts.map((c) => ({ campaignId, contactId: c.id })),
      skipDuplicates: true,
    });
  });
});
