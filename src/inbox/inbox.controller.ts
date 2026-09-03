import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { InboxService } from './inbox.service';

@Controller('inbox')
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  /** GET /inbox/stats — unread count for nav badge */
  @Get('stats')
  getStats() {
    return this.inboxService.getStats();
  }

  /** GET /inbox?page=1&limit=30&status=unread */
  @Get()
  getThreads(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.inboxService.getThreads(
      parseInt(page || '1', 10),
      parseInt(limit || '30', 10),
      status,
    );
  }

  /** GET /inbox/:id — full thread with all messages */
  @Get(':id')
  getThread(@Param('id') id: string) {
    return this.inboxService.getThread(id);
  }

  /** POST /inbox/:id/read — mark thread as read */
  @Post(':id/read')
  @HttpCode(200)
  markRead(@Param('id') id: string) {
    return this.inboxService.markRead(id);
  }

  /** POST /inbox/:id/archive — archive thread */
  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id') id: string) {
    return this.inboxService.archiveThread(id);
  }

  /** POST /inbox/:id/reply — send reply { body: string } */
  @Post(':id/reply')
  @HttpCode(200)
  sendReply(@Param('id') id: string, @Body() dto: { body: string }) {
    return this.inboxService.sendReply(id, dto.body);
  }
}
