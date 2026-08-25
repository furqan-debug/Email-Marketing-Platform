import { Injectable, Logger } from '@nestjs/common';
import {
  SESClient,
  SendRawEmailCommand,
} from '@aws-sdk/client-ses';
import type { EmailProvider, SendMessageOptions } from './email.provider';

@Injectable()
export class SesEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SesEmailProvider.name);
  private readonly client: SESClient;
  private readonly fromAddress: string;

  constructor() {
    // All config read from environment variables — nothing hardcoded.
    // Required: AWS_REGION, AWS_SES_FROM_ADDRESS
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

  async send(message: SendMessageOptions): Promise<{ providerId: string }> {
    const configurationSet = process.env.AWS_SES_CONFIGURATION_SET;
    const source = message.from || this.fromAddress;
    const replyToAddresses = message.replyTo && message.replyTo.length > 0
      ? message.replyTo
      : [source];

    // Build a raw MIME message so we can inject custom headers
    // (SendEmailCommand does not support arbitrary headers)
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const headers: string[] = [
      `From: ${source}`,
      `To: ${message.to}`,
      `Subject: ${this.encodeMimeHeader(message.subject)}`,
      `Reply-To: ${replyToAddresses.join(', ')}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    // RFC 8058 one-click unsubscribe headers — Gmail shows the blue "Unsubscribe" link
    if (message.listUnsubscribeUrl) {
      headers.push(`List-Unsubscribe: <${message.listUnsubscribeUrl}>`);
      headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
    }

    if (configurationSet) {
      headers.push(`X-SES-CONFIGURATION-SET: ${configurationSet}`);
    }

    const base64Body = Buffer.from(message.html, 'utf-8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') || '';

    const rawMessage = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    this.logger.log(
      `[SES] Sending email to ${message.to} from "${source}" | Subject: ${message.subject}` +
      (message.listUnsubscribeUrl ? ' | List-Unsubscribe header included' : ''),
    );

    const response = await this.client.send(
      new SendRawEmailCommand({
        RawMessage: { Data: Buffer.from(rawMessage, 'utf-8') },
      }),
    );

    const providerId = response.MessageId ?? 'ses-unknown';
    this.logger.log(`[SES] Sent successfully. MessageId: ${providerId}`);
    return { providerId };
  }

  /** Encode a header value as RFC 2047 UTF-8 base64 if it contains non-ASCII */
  private encodeMimeHeader(value: string): string {
    if (/[\x80-\xFF]/.test(value) || /[^\x20-\x7E]/.test(value)) {
      return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
    }
    return value;
  }
}

