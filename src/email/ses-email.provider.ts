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

    const senderDomain = source.includes('@') ? source.split('@')[1].replace(/>/g, '').trim() : 'digireps.org';
    const messageIdHeader = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${senderDomain}>`;

    // Build a raw MIME message with full RFC 5322 compliance
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const headers: string[] = [
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageIdHeader}`,
      `From: ${source}`,
      `To: ${message.to}`,
      `Subject: ${this.encodeMimeHeader(message.subject)}`,
      `Reply-To: ${replyToAddresses.join(', ')}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    // RFC 8058 one-click unsubscribe headers
    if (message.listUnsubscribeUrl) {
      headers.push(`List-Unsubscribe: <${message.listUnsubscribeUrl}>`);
      headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
    }

    // Email Threading: In-Reply-To & References
    if (message.inReplyTo) {
      const inReplyToFormatted = message.inReplyTo.startsWith('<') && message.inReplyTo.endsWith('>')
        ? message.inReplyTo
        : `<${message.inReplyTo}>`;
      headers.push(`In-Reply-To: ${inReplyToFormatted}`);

      const referencesFormatted = message.references
        ? (message.references.startsWith('<') && message.references.endsWith('>') ? message.references : `<${message.references}>`)
        : inReplyToFormatted;
      headers.push(`References: ${referencesFormatted}`);
    }

    if (configurationSet) {
      headers.push(`X-SES-CONFIGURATION-SET: ${configurationSet}`);
    }

    // Generate clean plain text counterpart for spam filter compliance
    const plainTextBody = this.htmlToPlainText(message.html);
    const base64PlainText = Buffer.from(plainTextBody, 'utf-8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') || '';

    const base64HtmlBody = Buffer.from(message.html, 'utf-8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') || '';

    // Multipart/alternative MUST contain text/plain first, then text/html
    const rawMessage = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8; format=flowed',
      'Content-Transfer-Encoding: base64',
      '',
      base64PlainText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64HtmlBody,
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

    const providerId = response.MessageId ?? messageIdHeader;
    this.logger.log(`[SES] Sent successfully. MessageId: ${providerId}`);
    return { providerId };
  }

  /** Convert HTML to clean plain text for multipart/alternative MIME */
  private htmlToPlainText(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<br\s*[\/]?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Encode a header value as RFC 2047 UTF-8 base64 if it contains non-ASCII */
  private encodeMimeHeader(value: string): string {
    if (/[\x80-\xFF]/.test(value) || /[^\x20-\x7E]/.test(value)) {
      return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
    }
    return value;
  }
}


