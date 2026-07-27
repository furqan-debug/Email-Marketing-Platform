import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider } from './email.provider';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class FakeEmailProvider implements EmailProvider {
  private readonly logger = new Logger(FakeEmailProvider.name);

  async send(message: { to: string; subject: string; html: string }): Promise<{ providerId: string }> {
    const providerId = `fake-${Math.random().toString(36).substring(7)}`;
    this.logger.log(`[FAKE SES] Sending email to ${message.to} | Subject: ${message.subject} | ProviderId: ${providerId}`);
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { providerId };
  }
}
