import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { EMAIL_PROVIDER } from './email.provider';
import type { EmailProvider } from './email.provider';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingService } from '../tracking/tracking.service';

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
    private readonly trackingService: TrackingService,
  ) {
    super();
  }

  async process(job: Job<EmailJobData, any, string>): Promise<{ providerId: string }> {
    this.logger.log(`Processing email job ${job.id} for ${job.data.to}`);

    let html = job.data.html;
    const initialMessageId = job.data.messageId;

    // ── Pre-send: generate tracking token and rewrite HTML ──────────────────
    if (initialMessageId) {
      try {
        const token = this.trackingService.generateToken(initialMessageId);
        // Save token to DB immediately so pixel/click can resolve it
        await this.trackingService.saveToken(initialMessageId, token);

        const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
        html = this.trackingService.wrapHtml(html, token, baseUrl);
        this.logger.log(`Injected tracking pixel and wrapped links for Message ${initialMessageId}`);
      } catch (err: any) {
        // Non-fatal: log and continue without tracking rather than blocking send
        this.logger.warn(`Tracking setup failed (continuing without tracking): ${err?.message ?? err}`);
      }
    }

    // ── Send email ───────────────────────────────────────────────────────────
    const result = await this.emailProvider.send({ ...job.data, html });
    this.logger.log(`Job ${job.id} completed with providerId: ${result.providerId}`);

    // ── Post-send: update Message.id to SES MessageId ───────────────────────
    if (initialMessageId && result.providerId) {
      try {
        await this.prisma.message.update({
          where: { id: initialMessageId },
          data: { id: result.providerId },
        });
        this.logger.log(`Updated Message ${initialMessageId} → SES MessageId ${result.providerId}`);
      } catch (err: any) {
        this.logger.warn(`Could not update Message ID: ${err?.message ?? err}`);
      }
    }

    return result;
  }
}
