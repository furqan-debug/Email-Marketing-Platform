import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import { ImapService } from './imap.service';

@Controller('imap')
export class ImapController {
  constructor(private readonly imapService: ImapService) {}

  /**
   * POST /imap/sync
   * Manually trigger an immediate sync of all configured IMAP mailboxes
   */
  @Post('sync')
  @HttpCode(200)
  async syncNow() {
    return this.imapService.syncAllInboxes();
  }

  /**
   * GET /imap/status
   * Get connection health and last sync timestamp
   */
  @Get('status')
  async getStatus() {
    return this.imapService.getStatus();
  }
}
