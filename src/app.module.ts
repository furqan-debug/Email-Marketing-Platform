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

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: 'localhost',
        port: 6379,
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
