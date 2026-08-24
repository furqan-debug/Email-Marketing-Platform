import { Injectable, Logger } from '@nestjs/common';
import {
  SESClient,
  SendEmailCommand,
  SendEmailCommandInput,
} from '@aws-sdk/client-ses';
import type { EmailProvider } from './email.provider';

@Injectable()
export class SesEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SesEmailProvider.name);
  private readonly client: SESClient;
  private readonly fromAddress: string;

  constructor() {
    // All config read from environment variables — nothing hardcoded.
    // Required: AWS_REGION, AWS_SES_FROM_ADDRESS
    // Credentials (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or
    // AWS_PROFILE, or an IAM role) are picked up automatically by the SDK.
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error('AWS_REGION environment variable is required for SesEmailProvider');
    }
    const fromAddress = process.env.AWS_SES_FROM_ADDRESS;
    if (!fromAddress) {
      throw new Error('AWS_SES_FROM_ADDRESS environment variable is required for SesEmailProvider');
    }

    this.fromAddress = fromAddress;
    this.client = new SESClient({ region });
  }

  async send(message: {
    to: string;
    subject: string;
    html: string;
    from?: string;
    replyTo?: string[];
  }): Promise<{ providerId: string }> {
    const configurationSet = process.env.AWS_SES_CONFIGURATION_SET;
    const source = message.from || this.fromAddress;

    const params: SendEmailCommandInput = {
      Source: source,
      Destination: { ToAddresses: [message.to] },
      Message: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: message.html, Charset: 'UTF-8' } },
      },
      ...(message.replyTo && message.replyTo.length > 0 ? { ReplyToAddresses: message.replyTo } : {}),
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    };

    this.logger.log(`[SES] Sending email to ${message.to} from "${source}" | Subject: ${message.subject}`);
    const response = await this.client.send(new SendEmailCommand(params));
    const providerId = response.MessageId ?? 'ses-unknown';
    this.logger.log(`[SES] Sent successfully. MessageId: ${providerId}`);
    return { providerId };
  }
}
