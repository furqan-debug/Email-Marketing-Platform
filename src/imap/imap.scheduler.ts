import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ImapService } from './imap.service';

@Injectable()
export class ImapScheduler {
  private readonly logger = new Logger(ImapScheduler.name);

  constructor(private readonly imapService: ImapService) {}

  /**
   * Automatically poll configured IMAP inboxes every 2 minutes for new prospect replies
   */
  @Cron('*/2 * * * *')
  async handleCron() {
    try {
      const summary = await this.imapService.syncAllInboxes();
      if (summary.status === 'ok' && summary.matchedReplies > 0) {
        this.logger.log('[IMAP Scheduler] Auto-synced inboxes: ' + summary.matchedReplies + ' new replies matched!');
      }
    } catch (err: any) {
      this.logger.error('[IMAP Scheduler] Auto-sync failed: ' + err?.message);
    }
  }
}
