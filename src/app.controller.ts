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
      orderBy: { name: 'asc' },
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

  /** DELETE /audiences/:id — delete audience (rejects if campaigns reference it) */
  @Delete('audiences/:id')
  @HttpCode(200)
  async deleteAudience(@Param('id') id: string) {
    const audience = await this.prisma.audience.findUnique({
      where: { id },
      include: { _count: { select: { campaigns: true } } },
    });
    if (!audience) throw new NotFoundException(`Audience ${id} not found`);
    if ((audience as any)._count.campaigns > 0) {
      throw new BadRequestException(
        `Audience ${id} has ${(audience as any)._count.campaigns} campaign(s) referencing it — remove them first.`,
      );
    }
    await this.prisma.audience.delete({ where: { id } });
    return { id, deleted: true };
  }
}
