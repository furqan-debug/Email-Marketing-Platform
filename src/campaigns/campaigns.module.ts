import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { TrackingModule } from '../tracking/tracking.module';
import { CampaignMessagesService } from './campaign-messages.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [
    PrismaModule,
    EmailModule,    // provides EMAIL_PROVIDER token + TrackingModule
    TrackingModule, // provides TrackingService
  ],
  controllers: [CampaignsController],
  providers: [CampaignMessagesService],
  exports: [CampaignMessagesService],
})
export class CampaignsModule {}
