import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { WorkflowsService, WorkflowJobData } from './workflows.service';

/**
 * Worker host for processing delayed workflow step jobs on the 'workflow' queue.
 */
@Processor('workflow')
export class WorkflowWorker extends WorkerHost {
  private readonly logger = new Logger(WorkflowWorker.name);

  constructor(private readonly workflowsService: WorkflowsService) {
    super();
  }

  async process(job: Job<WorkflowJobData, any, string>): Promise<{ status: string }> {
    this.logger.log(
      `Processing workflow job ${job.id}: executionId=${job.data.executionId}, stepNumber=${job.data.stepNumber}`,
    );

    const result = await this.workflowsService.executeStep(
      job.data.executionId,
      job.data.stepNumber,
    );

    return { status: result.status };
  }
}
