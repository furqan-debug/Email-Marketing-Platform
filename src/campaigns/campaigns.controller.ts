import { Controller, Param, Post } from '@nestjs/common';
import {
  CampaignMessagesService,
  GenerateMessagesResult,
} from './campaign-messages.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignMessages: CampaignMessagesService) {}

  /**
   * POST /campaigns/:id/generate-messages
   * Generates Message rows for every non-suppressed contact in the campaign's
   * audience. Suppressed contacts are silently skipped — no Message is created.
   * Returns { created, suppressed } counts.
   */
  @Post(':id/generate-messages')
  generateMessages(@Param('id') id: string): Promise<GenerateMessagesResult> {
    return this.campaignMessages.generateMessages(id);
  }
}
