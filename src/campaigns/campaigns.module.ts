import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { TrackingModule } from '../tracking/tracking.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CampaignMessagesService } from './campaign-messages.service';
import { CampaignSequencesService } from './campaign-sequences.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    TrackingModule,
    AnalyticsModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignMessagesService, CampaignSequencesService],
  exports: [CampaignMessagesService, CampaignSequencesService],
})
export class CampaignsModule {}

