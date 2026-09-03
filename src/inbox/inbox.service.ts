import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly sesClient: SESClient;

  constructor(private readonly prisma: PrismaService) {
    this.sesClient = new SESClient({
      region: process.env.AWS_REGION || 'us-east-2',
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }

  async createOrUpdateThread(params: {
    campaignId: string;
    contactId: string;
    contactEmail: string;
    contactName?: string;
    subject?: string;
    body: string;
    fromEmail: string;
    toEmail: string;
  }): Promise<void> {
    const { campaignId, contactId, contactEmail, contactName, subject, body, fromEmail, toEmail } = params;

    const thread = await this.prisma.inboxThread.upsert({
      where: { campaignId_contactId: { campaignId, contactId } },
      create: { campaignId, contactId, contactEmail, contactName, subject, status: 'unread' },
      update: { contactName: contactName ?? undefined, subject: subject ?? undefined, status: 'unread', updatedAt: new Date() },
    });

    const bodySnippet = body.slice(0, 100);
    const existing = await this.prisma.inboxMessage.findFirst({
      where: { threadId: thread.id, direction: 'inbound', body: bodySnippet },
    });

    if (!existing) {
      await this.prisma.inboxMessage.create({
        data: { threadId: thread.id, direction: 'inbound', fromEmail, toEmail, subject, body },
      });
      this.logger.log(`[Inbox] Stored inbound message from ${fromEmail} in thread ${thread.id}`);
    }
  }

  async getThreads(page = 1, limit = 30, status?: string) {
    const skip = (page - 1) * limit;
    const where: any = status ? { status } : {};

    const [threads, total, unreadCount] = await Promise.all([
      this.prisma.inboxThread.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          campaign: { select: { id: true, name: true, fromEmail: true, fromName: true } },
          messages: { orderBy: { sentAt: 'asc' }, take: 1, where: { direction: 'inbound' } },
        },
      }),
      this.prisma.inboxThread.count({ where }),
      this.prisma.inboxThread.count({ where: { status: 'unread' } }),
    ]);

    return { data: threads, total, page, limit, pages: Math.ceil(total / limit), unreadCount };
  }

  async getThread(id: string) {
    const thread = await this.prisma.inboxThread.findUnique({
      where: { id },
      include: {
        campaign: { select: { id: true, name: true, fromEmail: true, fromName: true, subject: true, htmlBody: true } },
        messages: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!thread) throw new NotFoundException(`Inbox thread ${id} not found`);
    return thread;
  }

  async markRead(id: string) {
    return this.prisma.inboxThread.update({ where: { id }, data: { status: 'read' }, select: { id: true, status: true } });
  }

  async archiveThread(id: string) {
    return this.prisma.inboxThread.update({ where: { id }, data: { status: 'archived' }, select: { id: true, status: true } });
  }

  async sendReply(id: string, body: string) {
    const thread = await this.prisma.inboxThread.findUnique({
      where: { id },
      include: { campaign: { select: { fromEmail: true, fromName: true, subject: true } } },
    });
    if (!thread) throw new NotFoundException(`Inbox thread ${id} not found`);

    const fromEmail = thread.campaign.fromEmail || process.env.AWS_SES_FROM_ADDRESS || 'noreply@digireps.org';
    const fromName = thread.campaign.fromName || 'DigiReps Team';
    const toEmail = thread.contactEmail;
    const replySubject = thread.subject
      ? (thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`)
      : 'Re: Your email';

    const result = await this.sesClient.send(
      new SendEmailCommand({
        Source: `${fromName} <${fromEmail}>`,
        Destination: { ToAddresses: [toEmail] },
        Message: {
          Subject: { Data: replySubject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: body, Charset: 'UTF-8' },
            Text: { Data: body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), Charset: 'UTF-8' },
          },
        },
      }),
    );

    await this.prisma.inboxMessage.create({
      data: { threadId: thread.id, direction: 'outbound', fromEmail, toEmail, subject: replySubject, body },
    });

    await this.prisma.inboxThread.update({ where: { id }, data: { status: 'replied', updatedAt: new Date() } });
    this.logger.log(`[Inbox] Sent reply to ${toEmail} (SES MessageId: ${result.MessageId})`);
    return { ok: true, messageId: result.MessageId };
  }

  async getStats() {
    const [total, unread, replied, archived] = await Promise.all([
      this.prisma.inboxThread.count(),
      this.prisma.inboxThread.count({ where: { status: 'unread' } }),
      this.prisma.inboxThread.count({ where: { status: 'replied' } }),
      this.prisma.inboxThread.count({ where: { status: 'archived' } }),
    ]);
    return { total, unread, replied, archived };
  }
}
