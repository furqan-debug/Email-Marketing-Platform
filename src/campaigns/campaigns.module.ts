import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { CampaignMessagesService } from './campaign-messages.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [
    PrismaModule,
    // Register the email queue so CampaignMessagesService can inject it
    BullModule.registerQueue({ name: 'email' }),
  ],
  controllers: [CampaignsController],
  providers: [CampaignMessagesService],
  exports: [CampaignMessagesService],
})
export class CampaignsModule {}
