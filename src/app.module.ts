import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { EmailModule } from './email/email.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TrackingModule } from './tracking/tracking.module';
import { ContactsModule } from './contacts/contacts.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { PrismaModule } from './prisma/prisma.module';
import { TemplatesModule } from './templates/templates.module';
import { ImapModule } from './imap/imap.module';
import { InboxModule } from './inbox/inbox.module';
import IORedis from 'ioredis';


@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;
        const isTls = redisUrl?.startsWith('rediss://');
        const connection = new IORedis(redisUrl || 'redis://localhost:6379', {
          maxRetriesPerRequest: null, // Required by BullMQ
          tls: isTls ? { rejectUnauthorized: false } : undefined,
          enableTLSForSentinelMode: false,
        });
        return { connection };
      },
    }),
    // ScheduleModule.forRoot() must be registered once at the root level
    // to activate all @Cron decorators across the application.
    ScheduleModule.forRoot(),
    EmailModule,
    WebhooksModule,
    TrackingModule,
    ContactsModule,
    CampaignsModule,
    AnalyticsModule,
    WorkflowsModule,
    PrismaModule,
    TemplatesModule,
    ImapModule,
    InboxModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}


