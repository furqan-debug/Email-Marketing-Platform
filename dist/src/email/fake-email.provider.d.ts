import { EmailProvider } from './email.provider';
export declare class FakeEmailProvider implements EmailProvider {
    private readonly logger;
    send(message: {
        to: string;
        subject: string;
        html: string;
    }): Promise<{
        providerId: string;
    }>;
}
