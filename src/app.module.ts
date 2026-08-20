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

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
          try {
            const parsed = new URL(redisUrl);
            // Upstash uses rediss:// (TLS). Detect and enable tls option.
            const isTls = parsed.protocol === 'rediss:';
            return {
              connection: {
                host: parsed.hostname,
                port: parseInt(parsed.port || (isTls ? '6380' : '6379'), 10),
                username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
                password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
                tls: isTls ? {} : undefined,
              },
            };
          } catch {
            // Fallback if URL parsing fails
          }
        }
        return {
          connection: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
          },
        };
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
