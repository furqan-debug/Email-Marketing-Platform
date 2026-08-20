import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prisma: PrismaService,
    @InjectQueue('email') private readonly emailQueue: Queue,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('test-email')
  async testEmail(@Query('to') to?: string) {
    const targetEmail = to || 'test@example.com';
    const job = await this.emailQueue.add('send', {
      to: targetEmail,
      subject: 'Test Email via Endpoint',
      html: '<p>This is a test.</p>',
    });
    return { message: `Enqueued job ${job.id} to ${targetEmail}` };
  }

  /** GET /templates — list all email templates */
  @Get('templates')
  listTemplates() {
    return this.prisma.template.findMany({
      select: { id: true, name: true, subject: true },
      orderBy: { name: 'asc' },
    });
  }

  /** POST /templates — create a new template */
  @Post('templates')
  @HttpCode(201)
  createTemplate(@Body() body: { name: string; subject?: string; html: string }) {
    return this.prisma.template.create({ data: body });
  }

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

  /** POST /audiences — create an audience in a workspace */
  @Post('audiences')
  @HttpCode(201)
  createAudience(@Body() body: { name: string; workspaceId: string }) {
    return this.prisma.audience.create({ data: body });
  }
}
