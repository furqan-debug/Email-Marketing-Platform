import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import type {
  SnsEnvelope,
  SesNotificationMessage,
  SesEventType,
} from './sns.types';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Main entry point. Returns a plain object that the controller serialises to JSON.
   */
  async handleSnsEnvelope(envelope: SnsEnvelope): Promise<{ status: string }> {
    switch (envelope.Type) {
      case 'SubscriptionConfirmation':
        return this.confirmSubscription(envelope);

      case 'Notification':
        return this.handleNotification(envelope);

      case 'UnsubscribeConfirmation':
        this.logger.warn('Received UnsubscribeConfirmation — ignoring');
        return { status: 'ignored' };

      default:
        this.logger.warn(`Unknown SNS message type: ${(envelope as SnsEnvelope).Type}`);
        return { status: 'unknown' };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async confirmSubscription(envelope: SnsEnvelope): Promise<{ status: string }> {
    if (!envelope.SubscribeURL) {
      this.logger.error('SubscriptionConfirmation missing SubscribeURL');
      return { status: 'error' };
    }
    this.logger.log(`Auto-confirming SNS subscription for topic: ${envelope.TopicArn}`);
    await firstValueFrom(this.http.get(envelope.SubscribeURL));
    this.logger.log('SNS subscription confirmed');
    return { status: 'confirmed' };
  }

  private async handleNotification(envelope: SnsEnvelope): Promise<{ status: string }> {
    if (!envelope.Message) {
      this.logger.warn('Notification envelope has no Message body');
      return { status: 'empty' };
    }

    let sesMessage: SesNotificationMessage;
    try {
      sesMessage = JSON.parse(envelope.Message) as SesNotificationMessage;
    } catch {
      this.logger.error('Failed to parse SES notification Message JSON');
      return { status: 'parse_error' };
    }

    const { eventType, mail } = sesMessage;
    const sesMessageId = mail?.messageId;

    if (!sesMessageId) {
      this.logger.warn('SES notification missing mail.messageId — skipping');
      return { status: 'skipped' };
    }

    const HANDLED: SesEventType[] = ['Send', 'Delivery', 'Bounce', 'Complaint', 'Open', 'Click'];
    if (!HANDLED.includes(eventType)) {
      this.logger.warn(`Unhandled SES eventType: ${eventType}`);
      return { status: 'unhandled_event_type' };
    }

    // Look up the Message row by its SES MessageId (stored as Message.id).
    // If the message hasn't been tracked yet we skip rather than error so
    // transient ordering issues don't crash the endpoint.
    const message = await this.prisma.message.findUnique({
      where: { id: sesMessageId },
    });

    if (!message) {
      this.logger.warn(`No Message row found for SES messageId: ${sesMessageId} — skipping`);
      return { status: 'message_not_found' };
    }

    const occurredAt = mail.timestamp ? new Date(mail.timestamp) : new Date();

    await this.prisma.event.create({
      data: {
        type: eventType,
        messageId: message.id,
        rawPayload: sesMessage as unknown as Record<string, unknown>,
        occurredAt,
      },
    });

    this.logger.log(`Created Event(type=${eventType}) for messageId=${message.id}`);
    return { status: 'ok' };
  }
}
