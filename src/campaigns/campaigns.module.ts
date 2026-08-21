import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { TrackingModule } from '../tracking/tracking.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CampaignMessagesService } from './campaign-messages.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    TrackingModule,
    AnalyticsModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignMessagesService],
  exports: [CampaignMessagesService],
})
export class CampaignsModule {}
