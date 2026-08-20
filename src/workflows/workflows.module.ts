import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkflowsService } from './workflows.service';
import { WorkflowWorker } from './workflow.worker';
import { WorkflowsController } from './workflows.controller';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue(
      { name: 'workflow' },
      { name: 'email' },
    ),
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowWorker],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
