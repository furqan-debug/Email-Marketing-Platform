import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { EMAIL_PROVIDER } from './email.provider';
import type { EmailProvider } from './email.provider';

import { PrismaService } from '../prisma/prisma.service';

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  messageId?: string;
}

@Processor('email')
export class EmailWorker extends WorkerHost {
  private readonly logger = new Logger(EmailWorker.name);

  constructor(
    @Inject(EMAIL_PROVIDER)
    private readonly emailProvider: EmailProvider,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<EmailJobData, any, string>): Promise<{ providerId: string }> {
    this.logger.log(`Processing email job ${job.id} for ${job.data.to}`);
    const result = await this.emailProvider.send(job.data);
    this.logger.log(`Job ${job.id} completed with providerId: ${result.providerId}`);

    if (job.data.messageId && result.providerId) {
      try {
        await this.prisma.message.update({
          where: { id: job.data.messageId },
          data: { id: result.providerId },
        });
        this.logger.log(`Updated Message ${job.data.messageId} ID to SES MessageId ${result.providerId}`);
      } catch (err: any) {
        this.logger.warn(`Could not update Message ID: ${err?.message ?? err}`);
      }
    }

    return result;
  }
}
