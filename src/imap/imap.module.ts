import { Module } from '@nestjs/common';
import { ImapService } from './imap.service';
import { ImapScheduler } from './imap.scheduler';
import { ImapController } from './imap.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { InboxModule } from '../inbox/inbox.module';

@Module({
  imports: [
    WebhooksModule,
    PrismaModule,
    AnalyticsModule,
    InboxModule,
  ],
  controllers: [ImapController],
  providers: [ImapService, ImapScheduler],
  exports: [ImapService],
})
export class ImapModule {}

