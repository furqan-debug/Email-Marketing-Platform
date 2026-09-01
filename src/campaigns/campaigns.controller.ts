import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CampaignMessagesService,
  CampaignStatusResult,
  GenerateMessagesResult,
} from './campaign-messages.service';
import { CampaignSequencesService, SaveStepDto } from './campaign-sequences.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignMessages: CampaignMessagesService,
    private readonly sequencesService: CampaignSequencesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /campaigns
   * Returns all campaigns with their analytics snapshots and step counts.
   */
  @Get()
  listCampaigns() {
    return this.prisma.campaign.findMany({
      include: {
        snapshot: true,
        steps: { select: { id: true, stepOrder: true, delayHours: true } },
      },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * GET /campaigns/:id
   * Returns a single campaign with its snapshot, steps, and lead counts.
   */
  @Get(':id')
  async getCampaign(@Param('id') id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        snapshot: true,
        steps: { orderBy: { stepOrder: 'asc' } },
        _count: { select: { leads: true, messages: true } },
      },
    });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  /**
   * PATCH /campaigns/:id
   * Update campaign details, sender info, tracking settings, or sequence steps.
   */
  @Patch(':id')
  async updateCampaign(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      subject?: string;
      fromName?: string;
      fromEmail?: string;
      replyTo?: string;
      htmlBody?: string;
      templateId?: string;
      trackOpens?: boolean;
      trackClicks?: boolean;
      status?: string;
      steps?: SaveStepDto[];
    },

  ) {
    const existing = await this.prisma.campaign.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException(`Campaign ${id} not found`);

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.subject !== undefined) updateData.subject = body.subject;
    if (body.fromName !== undefined) updateData.fromName = body.fromName;
    if (body.fromEmail !== undefined) updateData.fromEmail = body.fromEmail;
    if (body.replyTo !== undefined) updateData.replyTo = body.replyTo;
    if (body.htmlBody !== undefined) updateData.htmlBody = body.htmlBody;
    if (body.templateId !== undefined) updateData.templateId = body.templateId;
    if (body.trackOpens !== undefined) updateData.trackOpens = body.trackOpens;
    if (body.trackClicks !== undefined) updateData.trackClicks = body.trackClicks;
    if (body.status !== undefined) updateData.status = body.status;


    if (Object.keys(updateData).length > 0) {
      await this.prisma.campaign.update({
        where: { id },
        data: updateData,
      });
    }

    if (body.steps && body.steps.length > 0) {
      await this.sequencesService.saveSteps(id, body.steps);
    }

    return this.getCampaign(id);
  }

  /**
   * POST /campaigns
   * Body: { name, audienceId, subject?, fromName?, htmlBody?, templateId?, isSequence?, steps? }
   */
  @Post()
  @HttpCode(201)
  async createCampaign(
    @Body()
    body: {
      name: string;
      audienceId: string;
      subject?: string;
      fromName?: string;
      fromEmail?: string;
      replyTo?: string;
      htmlBody?: string;
      templateId?: string;
      isSequence?: boolean;
      trackOpens?: boolean;
      trackClicks?: boolean;
      steps?: SaveStepDto[];
    },
  ) {
    const hasSteps = body.steps && body.steps.length > 0;
    if (!body.htmlBody && !body.templateId && !hasSteps) {
      throw new BadRequestException(
        'Either htmlBody, templateId, or sequence steps are required — a campaign must have email content.',
      );
    }

    const campaign = await this.prisma.campaign.create({
      data: {
        name:       body.name,
        audienceId: body.audienceId,
        subject:    body.subject    ?? (hasSteps ? body.steps![0].subject ?? null : null),
        fromName:   body.fromName   ?? null,
        fromEmail:  body.fromEmail  ?? null,
        replyTo:    body.replyTo    ?? null,
        htmlBody:   body.htmlBody   ?? (hasSteps ? body.steps![0].htmlBody ?? null : null),
        templateId: body.templateId ?? null,
        isSequence: body.isSequence ?? hasSteps,
        trackOpens: body.trackOpens ?? true,
        trackClicks: body.trackClicks ?? true,
      },
    });



    if (hasSteps) {
      await this.sequencesService.saveSteps(campaign.id, body.steps!);
    }

    return this.getCampaign(campaign.id);
  }

  /**
   * GET /campaigns/:id/steps
   */
  @Get(':id/steps')
  async getSteps(@Param('id') id: string) {
    return this.sequencesService.getSteps(id);
  }

  /**
   * POST /campaigns/:id/steps
   */
  @Post(':id/steps')
  @HttpCode(200)
  async saveSteps(
    @Param('id') id: string,
    @Body() body: { steps: SaveStepDto[] },
  ) {
    return this.sequencesService.saveSteps(id, body.steps);
  }

  /**
   * GET /campaigns/:id/sequence-progress
   */
  @Get(':id/sequence-progress')
  async getSequenceProgress(@Param('id') id: string) {
    return this.sequencesService.getSequenceProgress(id);
  }

  /**
   * POST /campaigns/:id/generate-messages
   */
  @Post(':id/generate-messages')
  @HttpCode(200)
  async generateMessages(@Param('id') id: string): Promise<GenerateMessagesResult> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { isSequence: true },
    });
    if (campaign?.isSequence) {
      return { created: 0, suppressed: 0, skipped: 0 };
    }
    return this.campaignMessages.generateMessages(id);
  }

  /**
   * POST /campaigns/:id/send
   */
  @Post(':id/send')
  @HttpCode(200)
  async send(@Param('id') id: string): Promise<CampaignStatusResult> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { isSequence: true, steps: { select: { id: true } } },
    });

    if (campaign?.isSequence || (campaign?.steps && campaign.steps.length > 0)) {
      await this.sequencesService.startSequence(id);
      return { id, status: 'SENDING' };
    }

    return this.campaignMessages.startSending(id);
  }

  /**
   * POST /campaigns/:id/pause
   */
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.pauseCampaign(id);
  }

  /**
   * POST /campaigns/:id/resume
   */
  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.resumeCampaign(id);
  }

  /**
   * POST /campaigns/:id/cancel
   */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string): Promise<CampaignStatusResult> {
    return this.campaignMessages.cancelCampaign(id);
  }

  /**
   * DELETE /campaigns/:id
   */
  @Delete(':id')
  @HttpCode(200)
  async deleteCampaign(@Param('id') id: string): Promise<{ id: string; deleted: boolean }> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);

    const messages = await this.prisma.message.findMany({
      where: { campaignId: id },
      select: { id: true },
    });
    const messageIds = messages.map((m) => m.id);

    await this.prisma.$transaction([
      this.prisma.event.deleteMany({
        where: { messageId: { in: messageIds } },
      }),
      this.prisma.message.deleteMany({
        where: { campaignId: id },
      }),
      this.prisma.campaignLead.deleteMany({
        where: { campaignId: id },
      }),
      this.prisma.campaignStep.deleteMany({
        where: { campaignId: id },
      }),
      this.prisma.analyticsSnapshot.deleteMany({
        where: { campaignId: id },
      }),
      this.prisma.campaign.delete({
        where: { id },
      }),
    ]);

    return { id, deleted: true };
  }

  /**
   * POST /campaigns/:id/leads/:leadId/reply
   * Marks a lead as REPLIED, halts follow-ups, and logs a Reply event.
   */
  @Post(':id/leads/:leadId/reply')
  @HttpCode(200)
  async markLeadReplied(
    @Param('id') campaignId: string,
    @Param('leadId') leadId: string,
  ) {
    return this.sequencesService.markLeadReplied(campaignId, leadId);
  }

  /**
   * POST /campaigns/:id/reply
   * General endpoint for inbound reply tracking by email or contactId.
   */
  @Post(':id/reply')
  @HttpCode(200)
  async markReply(
    @Param('id') campaignId: string,
    @Body() body: { email?: string; contactId?: string; leadId?: string },
  ) {
    const target = body.leadId || body.contactId;
    if (target) {
      return this.sequencesService.markLeadReplied(campaignId, target);
    }
    if (body.email) {
      const contact = await this.prisma.contact.findFirst({
        where: { email: body.email },
      });
      if (contact) {
        return this.sequencesService.markLeadReplied(campaignId, contact.id);
      }
    }
    throw new BadRequestException('leadId, contactId, or email is required');
  }
}


