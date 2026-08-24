export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface SendMessageOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string[];
  /** RFC 8058 one-click unsubscribe URL — adds List-Unsubscribe + List-Unsubscribe-Post headers */
  listUnsubscribeUrl?: string;
}

export interface EmailProvider {
  send(message: SendMessageOptions): Promise<{ providerId: string }>;
}
