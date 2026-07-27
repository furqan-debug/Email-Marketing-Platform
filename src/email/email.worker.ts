import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { EMAIL_PROVIDER, EmailProvider } from './email.provider';

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
}

@Processor('email')
export class EmailWorker extends WorkerHost {
  private readonly logger = new Logger(EmailWorker.name);

  constructor(
    @Inject(EMAIL_PROVIDER)
    private readonly emailProvider: EmailProvider,
  ) {
    super();
  }

  async process(job: Job<EmailJobData, any, string>): Promise<{ providerId: string }> {
    this.logger.log(`Processing email job ${job.id} for ${job.data.to}`);
    const result = await this.emailProvider.send(job.data);
    this.logger.log(`Job ${job.id} completed with providerId: ${result.providerId}`);
    return result;
  }
}
