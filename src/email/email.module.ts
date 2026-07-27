import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FakeEmailProvider } from './fake-email.provider';
import { EMAIL_PROVIDER } from './email.provider';
import { EmailWorker } from './email.worker';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'email',
    }),
  ],
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useClass: FakeEmailProvider,
    },
    EmailWorker,
  ],
  exports: [BullModule, EMAIL_PROVIDER],
})
export class EmailModule {}
