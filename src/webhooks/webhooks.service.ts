import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';

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
    private readonly analyticsService: AnalyticsService,
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
    const mailObj = (mail || {}) as any;
    const notificationType = (sesMessage as any).notificationType;
    const sesMessageId = mailObj?.messageId;

    // 1. Check if this is an Inbound Email received via SES Receipt Rule
    const isReceived = notificationType === 'Received' || (eventType as string) === 'Received' || (sesMessage as any).receipt !== undefined;
    if (isReceived) {
      const headers: any[] = Array.isArray(mailObj?.headers) ? mailObj.headers : [];
      const inReplyToHeader = headers.find((h: any) => h.name?.toLowerCase() === 'in-reply-to')?.value;
      const referencesHeader = headers.find((h: any) => h.name?.toLowerCase() === 'references')?.value;
      const fromEmail = mailObj?.source || mailObj?.commonHeaders?.from?.[0] || (headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value) || '';
      const subject = mailObj?.commonHeaders?.subject || '';
      const content = (sesMessage as any).content || '';

      this.logger.log(`SES Inbound Email received from: ${fromEmail} (Subject: "${subject}")`);

      return this.handleInboundReply({
        from: fromEmail,
        to: mailObj?.destination?.[0],
        subject,
        inReplyTo: inReplyToHeader,
        references: referencesHeader,
        body: content,
      });
    }

    if (!sesMessageId) {
      this.logger.warn('SES notification missing mail.messageId — skipping');
      return { status: 'skipped' };
    }

    const HANDLED: SesEventType[] = ['Send', 'Delivery', 'Bounce', 'Complaint', 'Open', 'Click', 'Reply'];
    if (eventType && !HANDLED.includes(eventType)) {
      this.logger.warn(`Unhandled SES eventType: ${eventType}`);
      return { status: 'unhandled_event_type' };
    }

    const normalizedType = eventType;



    // Look up the Message row by its SES MessageId (stored as Message.id).
    const message = await this.prisma.message.findUnique({
      where: { id: sesMessageId },
    });

    if (!message) {
      this.logger.warn(`No Message row found for SES messageId: ${sesMessageId} — skipping`);
      return { status: 'message_not_found' };
    }

    // Debounce duplicate rapid Open/Click webhook events within 5 seconds
    if (normalizedType === 'Click' || normalizedType === 'Open') {
      const recentEvent = await this.prisma.event.findFirst({
        where: {
          messageId: message.id,
          type: normalizedType,
          occurredAt: {
            gte: new Date(Date.now() - 5000),
          },
        },
      });
      if (recentEvent) {
        this.logger.log(`Debounced duplicate webhook ${normalizedType} event for messageId=${message.id}`);
        return { status: 'debounced' };
      }
    }

    const occurredAt = mail.timestamp ? new Date(mail.timestamp) : new Date();

    await this.prisma.event.create({
      data: {
        type: normalizedType,
        messageId: message.id,
        rawPayload: sesMessage as unknown as Record<string, unknown>,
        occurredAt,
      },
    });


    // If prospect replied, automatically mark CampaignLead as REPLIED to stop follow-up sequences
    if (normalizedType === 'Reply') {
      try {
        await this.prisma.campaignLead.updateMany({
          where: {
            campaignId: message.campaignId,
            contactId: message.contactId,
          },
          data: {
            status: 'REPLIED',
            nextSendAt: null,
          },
        });
        this.logger.log(
          `CampaignLead for contact=${message.contactId} marked as REPLIED — follow-ups halted.`,
        );
      } catch (leadErr: any) {
        this.logger.warn(`Could not update lead to REPLIED: ${leadErr?.message}`);
      }
    }

    this.logger.log(`Created Event(type=${normalizedType}) for messageId=${message.id}`);
    return { status: 'ok' };
  }

  /**
   * Universal Inbound Reply Webhook
   * Accepts inbound email webhooks (from Cloudflare Email Routing, Postmark, SendGrid Inbound, SES Inbound S3/SNS, Zapier, etc.)
   * Automatically marks the sender as REPLIED and halts follow-up sequences.
   */
  async handleInboundReply(payload: {
    from: string;
    to?: string;
    subject?: string;
    inReplyTo?: string;
    references?: string;
    campaignId?: string;
    body?: string;
    text?: string;
    html?: string;
    receivedAt?: Date | string;
  }): Promise<{ status: string; matchedCount: number; contactEmail: string }> {
    const rawFrom = payload.from || '';
    const emailMatch = rawFrom.match(/<([^>]+)>/) || [null, rawFrom];
    const senderEmail = (emailMatch[1] || rawFrom).trim().toLowerCase();

    if (!senderEmail || !senderEmail.includes('@')) {
      throw new Error(`Invalid sender email address: "${rawFrom}"`);
    }

    const replyDate = payload.receivedAt ? new Date(payload.receivedAt) : new Date();

    this.logger.log(`Processing inbound reply from: ${senderEmail} (Subject: "${payload.subject || ''}", Date: ${replyDate.toISOString()})`);

    // Find contact by email across all audiences
    const contacts = await this.prisma.contact.findMany({
      where: { email: { equals: senderEmail, mode: 'insensitive' } },
      select: { id: true, audienceId: true },
    });

    if (contacts.length === 0) {
      this.logger.warn(`Inbound reply received from unknown contact: ${senderEmail}`);
      return { status: 'unmatched_contact', matchedCount: 0, contactEmail: senderEmail };
    }

    const contactIds = contacts.map(c => c.id);

    // 1. Find sent messages for this contact that were sent BEFORE or AT the reply time (with 2 min clock skew tolerance)
    const maxSendTime = new Date(replyDate.getTime() + 120000);
    const messagesWhere: any = {
      contactId: { in: contactIds },
      enqueuedAt: { not: null, lte: maxSendTime },
    };
    if (payload.campaignId) {
      messagesWhere.campaignId = payload.campaignId;
    }

    const eligibleMessages = await this.prisma.message.findMany({
      where: messagesWhere,
      orderBy: { enqueuedAt: 'desc' },
      include: {
        campaign: { select: { id: true, name: true, subject: true } },
      },
      take: 20,
    });

    if (eligibleMessages.length === 0) {
      this.logger.log(`No eligible prior messages found for contact ${senderEmail} sent before ${replyDate.toISOString()}`);
      return { status: 'no_messages_found', matchedCount: 0, contactEmail: senderEmail };
    }

    // Match the specific message / campaign:
    // 1. Match by Message-ID / inReplyTo / references
    // 2. Match by Subject line similarity
    // 3. Fallback: match the SINGLE most recently sent message before replyDate
    let matchedMessage = eligibleMessages[0];

    // Try inReplyTo / references
    const inReplyToClean = (payload.inReplyTo || '').replace(/[<>]/g, '').trim().toLowerCase();
    const referencesClean = (payload.references || '').replace(/[<>]/g, '').trim().toLowerCase();

    if (inReplyToClean || referencesClean) {
      const idMatch = eligibleMessages.find(m => {
        const mId = m.id.toLowerCase();
        return (inReplyToClean && inReplyToClean.includes(mId)) || (referencesClean && referencesClean.includes(mId));
      });
      if (idMatch) {
        matchedMessage = idMatch;
      }
    }

    // Try subject matching
    const normalizeSubj = (s: string) => s.replace(/^(re|fwd|fw|external):\s*/gi, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const replySubjNorm = normalizeSubj(payload.subject || '');

    if (replySubjNorm) {
      const subjMatch = eligibleMessages.find(m => {
        const cSubjNorm = normalizeSubj(m.campaign.subject || m.campaign.name || '');
        return cSubjNorm && (replySubjNorm.includes(cSubjNorm) || cSubjNorm.includes(replySubjNorm));
      });
      if (subjMatch) {
        matchedMessage = subjMatch;
      }
    }

    const matchedCampaignId = matchedMessage.campaignId;

    // Check if a Reply event was already recorded for this message
    const existingReply = await this.prisma.event.findFirst({
      where: {
        messageId: matchedMessage.id,
        type: 'Reply',
      },
    });

    let createdEvents = 0;
    if (!existingReply) {
      await this.prisma.event.create({
        data: {
          type: 'Reply',
          messageId: matchedMessage.id,
          rawPayload: {
            from: senderEmail,
            to: payload.to,
            subject: payload.subject,
            inReplyTo: payload.inReplyTo,
            references: payload.references,
            snippet: (payload.body || payload.text || '').slice(0, 500),
            receivedAt: replyDate.toISOString(),
          },
          occurredAt: replyDate,
        },
      });
      createdEvents++;
    }

    // Halt ONLY the matched campaign's follow-up sequence for this contact
    await this.prisma.campaignLead.updateMany({
      where: {
        contactId: { in: contactIds },
        campaignId: matchedCampaignId,
      },
      data: {
        status: 'REPLIED',
        nextSendAt: null,
      },
    });

    // Recompute analytics for the matched campaign
    try {
      await this.analyticsService.computeForCampaign(matchedCampaignId);
    } catch (aErr: any) {
      this.logger.warn(`Failed to auto-recompute analytics for ${matchedCampaignId}: ${aErr?.message}`);
    }

    this.logger.log(`Successfully matched Reply from ${senderEmail} to campaign ${matchedCampaignId}`);
    return {
      status: 'ok',
      matchedCount: createdEvents,
      contactEmail: senderEmail,
    };
  }
}




