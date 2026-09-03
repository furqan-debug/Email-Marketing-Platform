import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [
    HttpModule,   // provides HttpService for the SNS subscription confirmation GET
    PrismaModule, // provides PrismaService
    AnalyticsModule, // provides AnalyticsService
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

