import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { cleanEmailBody } from './email-cleaner';

@Injectable()
export class InboxService implements OnModuleInit {
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

  async onModuleInit() {
    await this.realignMismatchedMessages().catch(err =>
      this.logger.warn('Initial realign notice: ' + err?.message)
    );
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
    sentAt?: Date;
  }): Promise<void> {
    const { campaignId, contactId, contactEmail, contactName, subject, body, fromEmail, toEmail, sentAt } = params;
    const msgDate = sentAt ? new Date(sentAt) : new Date();

    const thread = await this.prisma.inboxThread.upsert({
      where: { campaignId_contactId: { campaignId, contactId } },
      create: { 
        campaignId, 
        contactId, 
        contactEmail, 
        contactName, 
        subject, 
        status: 'unread',
        createdAt: msgDate,
        updatedAt: msgDate,
      },
      update: { 
        contactName: contactName ?? undefined, 
        subject: subject ?? undefined, 
        updatedAt: msgDate,
      },
    });

    const cleanNew = cleanEmailBody(body).cleanText.trim();

    // Check if a message with matching body or clean body already exists in this thread
    const existingMessages = await this.prisma.inboxMessage.findMany({
      where: { threadId: thread.id, direction: 'inbound' },
      select: { id: true, body: true, sentAt: true },
    });

    const isDuplicate = existingMessages.some((m) => {
      if (m.body === body) return true;
      const cleanExisting = cleanEmailBody(m.body).cleanText.trim();
      return cleanExisting.length > 0 && cleanExisting === cleanNew;
    });

    if (!isDuplicate) {
      await this.prisma.inboxMessage.create({
        data: { 
          threadId: thread.id, 
          direction: 'inbound', 
          fromEmail, 
          toEmail, 
          subject, 
          body,
          sentAt: msgDate,
        },
      });
      // Update thread updatedAt to the latest message sentAt
      await this.prisma.inboxThread.update({
        where: { id: thread.id },
        data: { status: 'unread', updatedAt: msgDate },
      });
      this.logger.log(`[Inbox] Stored inbound message from ${fromEmail} (sent: ${msgDate.toISOString()}) in thread ${thread.id}`);
    }
  }

  async getThreads(page = 1, limit = 50, status?: string) {
    const skip = (page - 1) * limit;
    const where: any = status ? { status } : {};

    const [threads, total, unreadCount, repliedCount, archivedCount] = await Promise.all([
      this.prisma.inboxThread.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          campaign: { select: { id: true, name: true, fromEmail: true, fromName: true } },
          contact: { select: { id: true, email: true, firstName: true, lastName: true, attributes: true } },
          messages: { orderBy: { sentAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.inboxThread.count({ where }),
      this.prisma.inboxThread.count({ where: { status: 'unread' } }),
      this.prisma.inboxThread.count({ where: { status: 'replied' } }),
      this.prisma.inboxThread.count({ where: { status: 'archived' } }),
    ]);

    // Format threads with cleaned snippet and true lastActivityAt
    const formattedThreads = threads.map((t) => {
      const lastMsg = t.messages?.[0];
      let preview = '';
      if (lastMsg) {
        const cleaned = cleanEmailBody(lastMsg.body);
        preview = cleaned.cleanText.slice(0, 150);
      }
      const lastActivityAt = lastMsg?.sentAt ? new Date(lastMsg.sentAt) : new Date(t.updatedAt);
      return {
        ...t,
        preview,
        lastActivityAt: lastActivityAt.toISOString(),
      };
    });

    // Ensure strictly sorted by lastActivityAt DESC
    formattedThreads.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());

    return {
      data: formattedThreads,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      unreadCount,
      stats: {
        total: await this.prisma.inboxThread.count(),
        unread: unreadCount,
        replied: repliedCount,
        archived: archivedCount,
      },
    };
  }


  async getThread(id: string) {
    const thread = await this.prisma.inboxThread.findUnique({
      where: { id },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            fromEmail: true,
            fromName: true,
            subject: true,
            htmlBody: true,
          },
        },
        contact: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            attributes: true,
          },
        },
        messages: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!thread) throw new NotFoundException(`Inbox thread ${id} not found`);

    // Clean and deduplicate messages in memory
    const seenKeys = new Set<string>();
    const uniqueMessages: any[] = [];

    for (const msg of thread.messages || []) {
      const { cleanText, quotedText } = cleanEmailBody(msg.body);
      const key = `${msg.direction}_${cleanText.trim()}`;
      if (seenKeys.has(key)) {
        continue; // Skip duplicate message
      }
      seenKeys.add(key);
      uniqueMessages.push({
        ...msg,
        cleanBody: cleanText,
        quotedBody: quotedText,
      });
    }

    // Render merge tags in campaign body if contact has attributes
    let renderedCampaignHtml = thread.campaign?.htmlBody || '';
    if (renderedCampaignHtml && thread.contact) {
      const contact = thread.contact;
      const firstName = contact.firstName || thread.contactName?.split(' ')[0] || '';
      const lastName = contact.lastName || '';
      const attrs = (contact.attributes as Record<string, any>) || {};

      renderedCampaignHtml = renderedCampaignHtml
        .replace(/{{\s*first_name\s*}}/gi, firstName || 'there')
        .replace(/{{\s*firstName\s*}}/gi, firstName || 'there')
        .replace(/{{\s*last_name\s*}}/gi, lastName)
        .replace(/{{\s*email\s*}}/gi, contact.email);

      // Custom attributes
      for (const [key, val] of Object.entries(attrs)) {
        if (typeof val === 'string' || typeof val === 'number') {
          const reg = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
          renderedCampaignHtml = renderedCampaignHtml.replace(reg, String(val));
        }
      }
    }

    return {
      ...thread,
      campaign: thread.campaign
        ? {
            ...thread.campaign,
            renderedHtml: renderedCampaignHtml,
          }
        : null,
      messages: uniqueMessages,
    };
  }

  async markRead(id: string) {
    return this.prisma.inboxThread.update({ where: { id }, data: { status: 'read' }, select: { id: true, status: true } });
  }

  async markUnread(id: string) {
    return this.prisma.inboxThread.update({ where: { id }, data: { status: 'unread' }, select: { id: true, status: true } });
  }

  async archiveThread(id: string) {
    return this.prisma.inboxThread.update({ where: { id }, data: { status: 'archived' }, select: { id: true, status: true } });
  }

  async unarchiveThread(id: string) {
    return this.prisma.inboxThread.update({ where: { id }, data: { status: 'read' }, select: { id: true, status: true } });
  }


  async sendReply(id: string, body: string) {
    const thread = await this.prisma.inboxThread.findUnique({
      where: { id },
      include: { campaign: { select: { fromEmail: true, fromName: true, subject: true } } },
    });
    if (!thread) throw new NotFoundException(`Inbox thread ${id} not found`);

    const fromEmail = thread.campaign.fromEmail || process.env.AWS_SES_FROM_ADDRESS || 'daniel@digireps.org';
    const fromName = thread.campaign.fromName || 'Daniel Brooks';
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
            Html: { Data: body.replace(/\n/g, '<br/>'), Charset: 'UTF-8' },
            Text: { Data: body, Charset: 'UTF-8' },
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

  /**
   * Auto-realign any inbox messages that were incorrectly merged into the wrong campaign thread.
   * Compares each inbound message's subject against the thread's campaign and other campaigns sent to that contact.
   */
  async realignMismatchedMessages(): Promise<{ realigned: number }> {
    let realigned = 0;
    try {
      const threads = await this.prisma.inboxThread.findMany({
        include: {
          campaign: { select: { id: true, name: true, subject: true } },
          contact: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              messages: {
                select: {
                  campaignId: true,
                  campaign: { select: { id: true, name: true, subject: true } },
                },
              },
            },
          },
          messages: {
            where: { direction: 'inbound' },
            select: { id: true, subject: true, body: true, sentAt: true, fromEmail: true, toEmail: true },
          },
        },
      });

      const normalizeSubj = (s: string) =>
        s.replace(/^(re|fwd|fw|external):\s*/gi, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

      for (const thread of threads) {
        if (!thread.contact || !thread.contact.messages) continue;

        const currentCampSubj = normalizeSubj(thread.campaign?.subject || thread.campaign?.name || '');
        const campaignMap = new Map<string, { id: string; name?: string; subject?: string | null }>();
        for (const m of thread.contact.messages) {
          if (m.campaignId && m.campaign) {
            campaignMap.set(m.campaignId, m.campaign);
          }
        }
        const contactCampaigns = Array.from(campaignMap.values());

        if (contactCampaigns.length <= 1) continue; // Only 1 campaign sent to this contact

        for (const msg of thread.messages) {
          if (!msg.subject) continue;
          const msgSubjNorm = normalizeSubj(msg.subject);
          if (!msgSubjNorm) continue;

          // If message subject matches current thread campaign, keep it here
          const matchesCurrent = currentCampSubj && (msgSubjNorm === currentCampSubj || msgSubjNorm.includes(currentCampSubj));
          if (matchesCurrent) continue;

          // Find if it matches another campaign sent to this contact
          const otherCampaign = contactCampaigns.find(c => {
            if (c.id === thread.campaignId) return false;
            const cNorm = normalizeSubj(c.subject || c.name || '');
            return cNorm && cNorm.length >= 3 && (msgSubjNorm === cNorm || msgSubjNorm.includes(cNorm) || cNorm.includes(msgSubjNorm));
          });

          if (otherCampaign) {
            const targetThread = await this.prisma.inboxThread.upsert({
              where: {
                campaignId_contactId: {
                  campaignId: otherCampaign.id,
                  contactId: thread.contactId,
                },
              },
              create: {
                campaignId: otherCampaign.id,
                contactId: thread.contactId,
                contactEmail: thread.contactEmail,
                contactName: thread.contactName,
                subject: msg.subject,
                status: 'unread',
                createdAt: msg.sentAt,
                updatedAt: msg.sentAt,
              },
              update: {
                updatedAt: msg.sentAt,
              },
            });

            await this.prisma.inboxMessage.update({
              where: { id: msg.id },
              data: { threadId: targetThread.id },
            });

            realigned++;
            this.logger.log(`[Inbox Realign] Moved message "${msg.subject}" from campaign ${thread.campaignId} to campaign ${otherCampaign.id}`);
          }
        }
      }

      // Delete any orphaned threads that now have 0 messages
      const allThreads = await this.prisma.inboxThread.findMany({
        include: { _count: { select: { messages: true } } },
      });
      const emptyThreads = allThreads.filter(t => t._count.messages === 0);
      if (emptyThreads.length > 0) {
        await this.prisma.inboxThread.deleteMany({
          where: { id: { in: emptyThreads.map(t => t.id) } },
        });
      }
    } catch (err: any) {
      this.logger.warn(`[Inbox Realign] Notice: ${err?.message}`);
    }
    return { realigned };
  }
}
