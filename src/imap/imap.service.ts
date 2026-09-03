import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { InboxService } from '../inbox/inbox.service';
import { cleanEmailBody } from '../inbox/email-cleaner';


export interface ImapAccountConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user: string;
  pass: string;
}

@Injectable()
export class ImapService {
  private readonly logger = new Logger(ImapService.name);
  private isSyncing = false;
  private lastSyncedAt: Date | null = null;
  private lastSyncSummary: any = null;

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly prisma: PrismaService,
    private readonly inboxService: InboxService,
  ) {}


  /**
   * Get all configured IMAP accounts from environment variables
   */
  getAccounts(): ImapAccountConfig[] {
    const accounts: ImapAccountConfig[] = [];

    // 1. Check for JSON array of accounts: IMAP_ACCOUNTS='[{"user":"...","pass":"..."}]'
    if (process.env.IMAP_ACCOUNTS) {
      try {
        const parsed = JSON.parse(process.env.IMAP_ACCOUNTS);
        if (Array.isArray(parsed)) {
          for (const acc of parsed) {
            if (acc.user && acc.pass) {
              accounts.push({
                host: acc.host || process.env.IMAP_HOST || 'imap.gmail.com',
                port: Number(acc.port || process.env.IMAP_PORT || 993),
                secure: acc.secure !== undefined ? acc.secure : true,
                user: acc.user.trim(),
                pass: acc.pass.trim(),
              });
            }
          }
        }
      } catch (err: any) {
        this.logger.error('Failed to parse IMAP_ACCOUNTS: ' + err?.message);
      }
    }

    // 2. Check for single account environment variables: IMAP_USER & IMAP_PASSWORD
    const singleUser = process.env.IMAP_USER?.trim();
    const singlePass = (process.env.IMAP_PASSWORD || process.env.IMAP_PASS)?.trim();

    if (singleUser && singlePass) {
      const already = accounts.some(a => a.user.toLowerCase() === singleUser.toLowerCase());
      if (!already) {
        accounts.push({
          host: process.env.IMAP_HOST || 'imap.gmail.com',
          port: Number(process.env.IMAP_PORT || 993),
          secure: process.env.IMAP_SECURE !== 'false',
          user: singleUser,
          pass: singlePass,
        });
      }
    }

    return accounts;
  }

  /**
   * Sync all configured mailboxes
   */
  async syncAllInboxes(): Promise<{
    status: string;
    accountsConfigured: number;
    syncedInboxes: number;
    totalEmailsScanned: number;
    matchedReplies: number;
    lastSyncedAt: Date | null;
    errors: string[];
    message?: string;
  }> {
    if (this.isSyncing) {
      return {
        status: 'already_running',
        accountsConfigured: 0,
        syncedInboxes: 0,
        totalEmailsScanned: 0,
        matchedReplies: 0,
        lastSyncedAt: this.lastSyncedAt,
        errors: [],
      };
    }

    const accounts = this.getAccounts();
    if (accounts.length === 0) {
      return {
        status: 'no_accounts_configured',
        accountsConfigured: 0,
        syncedInboxes: 0,
        totalEmailsScanned: 0,
        matchedReplies: 0,
        lastSyncedAt: this.lastSyncedAt,
        errors: ['No IMAP accounts configured in environment variables (IMAP_USER / IMAP_PASSWORD or IMAP_ACCOUNTS)'],
        message: 'No IMAP accounts configured. Please add IMAP_USER and IMAP_PASSWORD in Railway variables.',
      };
    }

    this.isSyncing = true;
    let syncedInboxes = 0;
    let totalEmailsScanned = 0;
    let matchedReplies = 0;
    const errors: string[] = [];

    try {
      for (const account of accounts) {
        try {
          const res = await this.syncSingleAccount(account);
          syncedInboxes++;
          totalEmailsScanned += res.scanned;
          matchedReplies += res.matched;
        } catch (accErr: any) {
          const msg = 'Error syncing IMAP for ' + account.user + ': ' + accErr?.message;
          this.logger.error(msg);
          errors.push(msg);
        }
      }

      this.lastSyncedAt = new Date();
      this.lastSyncSummary = {
        status: 'ok',
        accountsConfigured: accounts.length,
        syncedInboxes,
        totalEmailsScanned,
        matchedReplies,
        lastSyncedAt: this.lastSyncedAt,
        errors,
      };

      return this.lastSyncSummary;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Connect to a single IMAP mailbox and scan for prospect replies
   */
  private async syncSingleAccount(account: ImapAccountConfig): Promise<{ scanned: number; matched: number }> {
    this.logger.log('Starting IMAP sync for: ' + account.user + ' (' + account.host + ':' + account.port + ')');

    const client = new ImapFlow({
      host: account.host || 'imap.gmail.com',
      port: account.port || 993,
      secure: account.secure !== undefined ? account.secure : true,
      auth: {
        user: account.user,
        pass: account.pass,
      },
      logger: false,
    });

    let scanned = 0;
    let matched = 0;

    await client.connect();

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Query recent emails from the past 30 days (extended for Inbox history)
        const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const searchRange = { since: sinceDate };

        const messages = client.fetch(searchRange, {
          envelope: true,
          flags: true,
          internalDate: true,
          bodyStructure: true,
          source: true,
        });

        for await (const message of messages) {
          scanned++;
          const env = message.envelope;
          if (!env) continue;

          const fromEmail = env.from?.[0]?.address?.toLowerCase()?.trim() || '';
          const fromName = env.from?.[0]?.name || '';
          const toEmail = env.to?.[0]?.address?.toLowerCase()?.trim() || account.user;
          const subject = env.subject || '';
          const inReplyTo = env.inReplyTo || '';
          const messageId = env.messageId || '';

          if (!fromEmail || fromEmail === account.user.toLowerCase()) {
            continue; // Skip outgoing or self-sent emails
          }

          // Extract body text from source buffer
          let bodyText = '';
          try {
            if (message.source) {
              const raw = message.source.toString('utf8');
              const { cleanText } = cleanEmailBody(raw);
              bodyText = cleanText || `[Reply from ${fromEmail}: ${subject}]`;
            }
          } catch (bodyErr: any) {
            bodyText = `[Reply from ${fromEmail}: ${subject}]`;
          }

          if (!bodyText) bodyText = `[Reply from ${fromEmail}: ${subject}]`;


          // Process inbound email through our universal reply processor
          try {
            const result = await this.webhooksService.handleInboundReply({
              from: fromEmail,
              to: toEmail,
              subject,
              inReplyTo,
              references: messageId,
              body: bodyText,
            });

            if (result.status === 'ok' && result.matchedCount > 0) {
              matched += result.matchedCount;
              this.logger.log('[IMAP Sync] Logged reply from ' + fromEmail + ' (Subject: "' + subject + '")');

              // Find the contact and campaign to build an inbox thread
              try {
                const contacts = await this.prisma.contact.findMany({
                  where: { email: { equals: fromEmail, mode: 'insensitive' } },
                  select: { id: true, firstName: true, lastName: true },
                });

                if (contacts.length > 0) {
                  const contact = contacts[0];
                  const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || fromName || undefined;

                  // Find recent messages for this contact to get campaignId
                  const recentMsg = await this.prisma.message.findFirst({
                    where: { contactId: contact.id },
                    orderBy: { enqueuedAt: 'desc' },
                    select: { campaignId: true },
                  });

                  if (recentMsg) {
                    await this.inboxService.createOrUpdateThread({
                      campaignId: recentMsg.campaignId,
                      contactId: contact.id,
                      contactEmail: fromEmail,
                      contactName,
                      subject,
                      body: bodyText,
                      fromEmail,
                      toEmail,
                    });
                  }
                }
              } catch (inboxErr: any) {
                this.logger.warn('[IMAP Sync] Failed to create inbox thread: ' + inboxErr?.message);
              }
            }
          } catch (replyErr: any) {
            this.logger.warn('[IMAP Sync] Error processing reply from ' + fromEmail + ': ' + replyErr?.message);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    this.logger.log('[IMAP Sync] Finished ' + account.user + ': scanned ' + scanned + ', matched ' + matched + ' replies.');
    return { scanned, matched };
  }

  getStatus() {
    const accounts = this.getAccounts();
    return {
      configured: accounts.length > 0,
      accountsCount: accounts.length,
      accounts: accounts.map(a => ({ user: a.user, host: a.host, port: a.port })),
      isSyncing: this.isSyncing,
      lastSyncedAt: this.lastSyncedAt,
      lastSyncSummary: this.lastSyncSummary,
    };
  }
}

