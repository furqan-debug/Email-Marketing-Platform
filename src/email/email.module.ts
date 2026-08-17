import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FakeEmailProvider } from './fake-email.provider';
import { SesEmailProvider } from './ses-email.provider';
import { EMAIL_PROVIDER } from './email.provider';
import { EmailWorker } from './email.worker';

import { PrismaModule } from '../prisma/prisma.module';
import { TrackingModule } from '../tracking/tracking.module';

/**
 * Set EMAIL_PROVIDER_DRIVER=ses in your environment to use the real AWS SES
 * provider. Any other value (or omitting the variable) uses FakeEmailProvider.
 */
const useSes = process.env.EMAIL_PROVIDER_DRIVER === 'ses';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'email',
    }),
    PrismaModule,
    TrackingModule,
  ],
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useClass: useSes ? SesEmailProvider : FakeEmailProvider,
    },
    EmailWorker,
  ],
  exports: [BullModule, EMAIL_PROVIDER],
})
export class EmailModule {}
