export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface SendMessageOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string[];
}

export interface EmailProvider {
  send(message: SendMessageOptions): Promise<{ providerId: string }>;
}
