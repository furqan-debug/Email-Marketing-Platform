import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AppService } from './app.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly prisma: PrismaService,
    @InjectQueue('email') private readonly emailQueue: Queue,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  /** GET /workspaces — list all workspaces */
  @Get('workspaces')
  listWorkspaces() {
    return this.prisma.workspace.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** POST /workspaces — create a workspace */
  @Post('workspaces')
  @HttpCode(201)
  createWorkspace(@Body() body: { name: string }) {
    return this.prisma.workspace.create({ data: { name: body.name } });
  }

  // ── Audiences ─────────────────────────────────────────────────────────────

  /** GET /audiences?workspaceId= — list audiences (with contact count) */
  @Get('audiences')
  listAudiences(@Query('workspaceId') workspaceId?: string) {
    return this.prisma.audience.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      select: {
        id: true,
        name: true,
        workspaceId: true,
        _count: { select: { contacts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }


  /** POST /audiences — create an audience in a workspace */
  @Post('audiences')
  @HttpCode(201)
  createAudience(@Body() body: { name: string; workspaceId: string }) {
    return this.prisma.audience.create({ data: body });
  }

  /** GET /audiences/:id — get a single audience with contact count */
  @Get('audiences/:id')
  async getAudience(@Param('id') id: string) {
    const audience = await this.prisma.audience.findUnique({
      where: { id },
      include: { _count: { select: { contacts: true, campaigns: true } } },
    });
    if (!audience) throw new NotFoundException(`Audience ${id} not found`);
    return audience;
  }

  /** DELETE /audiences/:id — delete audience with seamless cascade */
  @Delete('audiences/:id')
  @HttpCode(200)
  async deleteAudience(@Param('id') id: string) {
    const audience = await this.prisma.audience.findUnique({
      where: { id },
    });
    if (!audience) throw new NotFoundException(`Audience ${id} not found`);

    // 1. Find all campaigns for this audience
    const campaigns = await this.prisma.campaign.findMany({
      where: { audienceId: id },
      select: { id: true },
    });
    const campaignIds = campaigns.map((c: any) => c.id);

    // 2. Find all messages for those campaigns
    const messages = await this.prisma.message.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { id: true },
    });
    const messageIds = messages.map((m: any) => m.id);

    // 3. Find all contacts in this audience
    const contacts = await this.prisma.contact.findMany({
      where: { audienceId: id },
      select: { id: true },
    });
    const contactIds = contacts.map((c: any) => c.id);

    // 4. Cascade delete everything in a single transaction
    await this.prisma.$transaction([
      // Delete events for campaign messages
      this.prisma.event.deleteMany({
        where: { messageId: { in: messageIds } },
      }),
      // Delete messages
      this.prisma.message.deleteMany({
        where: { campaignId: { in: campaignIds } },
      }),
      // Delete analytics snapshots
      this.prisma.analyticsSnapshot.deleteMany({
        where: { campaignId: { in: campaignIds } },
      }),
      // Delete campaigns
      this.prisma.campaign.deleteMany({
        where: { audienceId: id },
      }),
      // Delete workflow executions for audience contacts
      this.prisma.workflowExecution.deleteMany({
        where: { contactId: { in: contactIds } },
      }),
      // Delete contacts
      this.prisma.contact.deleteMany({
        where: { audienceId: id },
      }),
      // Delete audience itself
      this.prisma.audience.delete({
        where: { id },
      }),
    ]);

    return { id, deleted: true };
  }
}
