export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface EmailProvider {
  send(message: { to: string; subject: string; html: string }): Promise<{ providerId: string }>;
}
