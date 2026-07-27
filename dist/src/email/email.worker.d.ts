import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EmailProvider } from './email.provider';
export interface EmailJobData {
    to: string;
    subject: string;
    html: string;
}
export declare class EmailWorker extends WorkerHost {
    private readonly emailProvider;
    private readonly logger;
    constructor(emailProvider: EmailProvider);
    process(job: Job<EmailJobData, any, string>): Promise<{
        providerId: string;
    }>;
}
