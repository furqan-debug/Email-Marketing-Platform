import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  CampaignMessagesService,
  CampaignStatusResult,
  GenerateMessagesResult,
} from './campaign-messages.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignMessages: CampaignMessagesService) {}

  /**
   * POST /campaigns/:id/generate-messages
   * Generates (and de-duplicates) Message rows for all non-suppressed contacts.
   * Idempotent — safe to call multiple times.
   */
  @Post(':id/generate-messages')
  @HttpCode(200)
  generateMessages(@Param('id') id: string): Promise<GenerateMessagesResult> {
    return this.campaignMessages.generateMessages(id);
  }

  /**
   * POST /campaigns/:id/send
   * Sets campaign status → SENDING and fire-and-forgets the dispatch loop.
   * Returns immediately with { id, status: 'SENDING' }.
   */
  @Post(':id/send')
  @HttpCode(200)
  send(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.startSending(id);
  }

  /**
   * POST /campaigns/:id/pause
   * Stops the dispatch loop after the current in-flight enqueue completes.
   * Messages already in the BullMQ queue are NOT affected — they will still send.
   * Requires current status to be SENDING.
   */
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.pauseCampaign(id);
  }

  /**
   * POST /campaigns/:id/resume
   * Re-triggers the dispatch loop for all messages with enqueuedAt = null.
   * Requires current status to be PAUSED.
   */
  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.resumeCampaign(id);
  }

  /**
   * POST /campaigns/:id/cancel
   * Permanently stops future generation and enqueueing.
   * Messages already in BullMQ will still be sent — cancel does not drain the queue.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.cancelCampaign(id);
  }
}
