import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CampaignMessagesService,
  CampaignStatusResult,
  GenerateMessagesResult,
} from './campaign-messages.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignMessages: CampaignMessagesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /campaigns
   * Returns all campaigns (id, name, status, audienceId).
   */
  @Get()
  listCampaigns() {
    return this.prisma.campaign.findMany({
      select: { id: true, name: true, status: true, audienceId: true },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * GET /campaigns/:id
   * Returns a single campaign with its snapshot.
   */
  @Get(':id')
  async getCampaign(@Param('id') id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: { snapshot: true },
    });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  /**
   * POST /campaigns
   * Body: { name, audienceId, subject?, fromName?, htmlBody?, templateId? }
   * Either htmlBody or templateId is required — a campaign with no body cannot be sent.
   * Creates a new campaign in DRAFT status.
   */
  @Post()
  @HttpCode(201)
  createCampaign(
    @Body()
    body: {
      name: string;
      audienceId: string;
      subject?: string;
      fromName?: string;
      htmlBody?: string;
      templateId?: string;
    },
  ) {
    if (!body.htmlBody && !body.templateId) {
      throw new BadRequestException(
        'Either htmlBody or templateId is required — a campaign must have an email body.',
      );
    }
    return this.prisma.campaign.create({
      data: {
        name:       body.name,
        audienceId: body.audienceId,
        subject:    body.subject    ?? null,
        fromName:   body.fromName   ?? null,
        htmlBody:   body.htmlBody   ?? null,
        templateId: body.templateId ?? null,
      },
    });
  }


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
