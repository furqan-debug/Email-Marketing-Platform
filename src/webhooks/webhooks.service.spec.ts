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
// Test suite
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
      message: { findUnique: prismaMessageFindUnique },
      event:   { create:     prismaEventCreate     },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: HttpService,    useValue: mockHttpService   },
        { provide: PrismaService,  useValue: mockPrismaService },
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

  describe('UnsubscribeConfirmation', () => {
    it('ignores the message and returns { status: "ignored" }', async () => {
      const envelope: SnsEnvelope = {
        Type: 'UnsubscribeConfirmation',
        MessageId: 'unsub-001',
        TopicArn: 'arn:aws:sns:us-east-1:123:ses-events',
        Timestamp: '2024-01-15T12:00:00Z',
      };

      const result = await service.handleSnsEnvelope(envelope);

      expect(httpGet).not.toHaveBeenCalled();
      expect(prismaEventCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'ignored' });
    });
  });
});
