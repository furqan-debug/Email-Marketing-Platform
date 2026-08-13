import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
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
}
