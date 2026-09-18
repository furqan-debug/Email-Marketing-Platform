/**
 * WebhooksService unit test.
 *
 * PrismaService is mocked at the module level so Jest never imports the
 * Prisma-generated ESM client (which uses import.meta.url and cannot run
 * in Jest's CommonJS transform mode). No live DB or network is needed.
 */

// ── Mock PrismaService before any import resolves it ──────────────────────
jest.mock('../prisma/prisma.service');

import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import type { AxiosResponse } from 'axios';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { SnsEnvelope } from './sns.types';

// Fixtures
import subscriptionConfirmation from './fixtures/sns-subscription-confirmation.json';
import notificationDelivery from './fixtures/sns-notification-delivery.json';
import notificationBounce from './fixtures/sns-notification-bounce.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAxiosResponse(): AxiosResponse {
  return {
    data: {},
    status: 200,
    statusText: 'OK',
    headers: {} as any,
    config: {} as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhooksService', () => {
  let service: WebhooksService;
  let httpGet: jest.Mock;
  let prismaMessageFindUnique: jest.Mock;
  let prismaEventCreate: jest.Mock;

  beforeEach(async () => {
    httpGet = jest.fn();
    prismaMessageFindUnique = jest.fn();
    prismaEventCreate = jest.fn();

    const mockHttpService = { get: httpGet };
    const mockPrismaService = {
      message:      { findUnique: prismaMessageFindUnique, findMany: jest.fn() },
      event:        { create:     prismaEventCreate, findFirst: jest.fn() },
      contact:      { findMany: jest.fn() },
      campaignLead: { updateMany: jest.fn(), findFirst: jest.fn() },
    };
    const mockAnalyticsService = {
      computeForCampaign: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: HttpService,       useValue: mockHttpService      },
        { provide: PrismaService,     useValue: mockPrismaService    },
        { provide: AnalyticsService,  useValue: mockAnalyticsService },
      ],
    }).compile();

    service = module.get(WebhooksService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // SubscriptionConfirmation
  // -------------------------------------------------------------------------

  describe('SubscriptionConfirmation', () => {
    it('auto-confirms by GETting the SubscribeURL and returns { status: "confirmed" }', async () => {
      httpGet.mockReturnValue(of(mockAxiosResponse()));

      const result = await service.handleSnsEnvelope(
        subscriptionConfirmation as SnsEnvelope,
      );

      expect(httpGet).toHaveBeenCalledTimes(1);
      expect(httpGet).toHaveBeenCalledWith(subscriptionConfirmation.SubscribeURL);
      expect(result).toEqual({ status: 'confirmed' });
    });

    it('returns { status: "error" } when SubscribeURL is missing', async () => {
      const envelope: SnsEnvelope = {
        Type: 'SubscriptionConfirmation',
        MessageId: 'test-id',
        TopicArn: 'arn:aws:sns:us-east-1:123:topic',
        Timestamp: '2024-01-01T00:00:00Z',
        // SubscribeURL intentionally omitted
      };
      const result = await service.handleSnsEnvelope(envelope);
      expect(httpGet).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'error' });
    });
  });

  // -------------------------------------------------------------------------
  // Notification — Delivery
  // -------------------------------------------------------------------------

  describe('Notification — Delivery', () => {
    it('creates an Event row of type Delivery and returns { status: "ok" }', async () => {
      const sesMessage = JSON.parse(notificationDelivery.Message);
      const messageId = sesMessage.mail.messageId; // "msg-001"

      prismaMessageFindUnique.mockResolvedValue({ id: messageId, campaignId: 'c1', contactId: 'ct1' });
      prismaEventCreate.mockResolvedValue({ id: 'event-1' });

      const result = await service.handleSnsEnvelope(notificationDelivery as SnsEnvelope);

      expect(prismaMessageFindUnique).toHaveBeenCalledWith({ where: { id: messageId } });
      expect(prismaEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'Delivery', messageId }),
        }),
      );
      expect(result).toEqual({ status: 'ok' });
    });

    it('returns { status: "message_not_found" } when no Message row exists', async () => {
      prismaMessageFindUnique.mockResolvedValue(null);

      const result = await service.handleSnsEnvelope(notificationDelivery as SnsEnvelope);

      expect(prismaEventCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'message_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Notification — Bounce
  // -------------------------------------------------------------------------

  describe('Notification — Bounce', () => {
    it('creates an Event row of type Bounce and returns { status: "ok" }', async () => {
      const sesMessage = JSON.parse(notificationBounce.Message);
      const messageId = sesMessage.mail.messageId; // "msg-002"

      prismaMessageFindUnique.mockResolvedValue({ id: messageId, campaignId: 'c1', contactId: 'ct1' });
      prismaEventCreate.mockResolvedValue({ id: 'event-2' });

      const result = await service.handleSnsEnvelope(notificationBounce as SnsEnvelope);

      expect(prismaEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'Bounce', messageId }),
        }),
      );
      expect(result).toEqual({ status: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // UnsubscribeConfirmation
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Inbound Reply Threading Across Multiple Campaigns
  // -------------------------------------------------------------------------

  describe('Inbound Reply Threading', () => {
    it('accurately separates replies into different campaigns for the same contact by subject', async () => {
      const contact = { id: 'contact-1', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' };
      const campaign1Msg = {
        id: 'msg-camp-1',
        campaignId: 'camp-1',
        contactId: 'contact-1',
        enqueuedAt: new Date(Date.now() - 3600000),
        campaign: { id: 'camp-1', name: 'Partnership Outreach', subject: 'Partnership with Acme' },
        contact,
      };
      const campaign2Msg = {
        id: 'msg-camp-2',
        campaignId: 'camp-2',
        contactId: 'contact-1',
        enqueuedAt: new Date(Date.now() - 1800000),
        campaign: { id: 'camp-2', name: 'Demo Sequence', subject: 'Exclusive Demo Invitation' },
        contact,
      };

      (service as any).prisma.contact.findMany = jest.fn().mockResolvedValue([contact]);
      (service as any).prisma.message.findMany = jest.fn().mockResolvedValue([campaign2Msg, campaign1Msg]);
      (service as any).prisma.event.findFirst = jest.fn().mockResolvedValue(null);
      (service as any).prisma.event.create = jest.fn().mockResolvedValue({ id: 'evt-1' });
      (service as any).prisma.campaignLead.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      (service as any).prisma.campaignLead.findFirst = jest.fn().mockResolvedValue(null);

      // Reply to Campaign 1
      const res1 = await service.handleInboundReply({
        from: 'Alice Smith <alice@example.com>',
        subject: 'Re: Partnership with Acme',
        body: 'Interested in partnering!',
      });

      expect(res1.status).toBe('ok');
      expect(res1.campaignId).toBe('camp-1');
      expect(res1.contactId).toBe('contact-1');

      // Reply to Campaign 2
      const res2 = await service.handleInboundReply({
        from: 'alice@example.com',
        subject: 'Re: Exclusive Demo Invitation',
        body: 'When can we do the demo?',
      });

      expect(res2.status).toBe('ok');
      expect(res2.campaignId).toBe('camp-2');
      expect(res2.contactId).toBe('contact-1');
    });

    it('matches campaign by In-Reply-To Message-ID even when subjects vary', async () => {
      const contact = { id: 'contact-1', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' };
      const campaign1Msg = {
        id: 'ses-msg-uuid-1',
        campaignId: 'camp-1',
        contactId: 'contact-1',
        enqueuedAt: new Date(Date.now() - 3600000),
        campaign: { id: 'camp-1', name: 'Campaign 1', subject: 'Subject 1' },
        contact,
      };
      const campaign2Msg = {
        id: 'ses-msg-uuid-2',
        campaignId: 'camp-2',
        contactId: 'contact-1',
        enqueuedAt: new Date(Date.now() - 1800000),
        campaign: { id: 'camp-2', name: 'Campaign 2', subject: 'Subject 2' },
        contact,
      };

      (service as any).prisma.contact.findMany = jest.fn().mockResolvedValue([contact]);
      (service as any).prisma.message.findMany = jest.fn().mockResolvedValue([campaign2Msg, campaign1Msg]);
      (service as any).prisma.event.findFirst = jest.fn().mockResolvedValue(null);
      (service as any).prisma.event.create = jest.fn().mockResolvedValue({ id: 'evt-2' });
      (service as any).prisma.campaignLead.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      (service as any).prisma.campaignLead.findFirst = jest.fn().mockResolvedValue(null);

      const res = await service.handleInboundReply({
        from: 'alice@example.com',
        subject: 'Quick question',
        inReplyTo: '<ses-msg-uuid-1@email.amazonses.com>',
        body: 'Can you tell me more?',
      });

      expect(res.status).toBe('ok');
      expect(res.campaignId).toBe('camp-1');
      expect(res.messageId).toBe('ses-msg-uuid-1');
    });
  });
});
