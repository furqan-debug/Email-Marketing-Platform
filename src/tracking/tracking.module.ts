import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ContactsModule } from '../contacts/contacts.module';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';

@Module({
  imports: [PrismaModule, ContactsModule],
  providers: [TrackingService],
  controllers: [TrackingController],
  exports: [TrackingService],
})
export class TrackingModule {}
