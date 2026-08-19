import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CampaignMessagesService } from './campaign-messages.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [PrismaModule],
  controllers: [CampaignsController],
  providers: [CampaignMessagesService],
  exports: [CampaignMessagesService],
})
export class CampaignsModule {}
