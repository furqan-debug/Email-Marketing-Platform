import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CampaignMessagesService } from './campaign-messages.service';

@Module({
  imports: [PrismaModule],
  providers: [CampaignMessagesService],
  exports: [CampaignMessagesService],
})
export class CampaignsModule {}
