import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { WorkflowsService } from './workflows.service';

export class TriggerWelcomeSeriesDto {
  contactId: string;
}

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  /**
   * POST /workflows/welcome-series/trigger
   * Triggers the 3-step Welcome Series workflow for a contact.
   * Schedules Step 1 immediately and returns the WorkflowExecution.
   */
  @Post('welcome-series/trigger')
  @HttpCode(200)
  triggerWelcomeSeries(@Body() dto: TriggerWelcomeSeriesDto) {
    return this.workflowsService.triggerWelcomeSeries(dto.contactId);
  }

  /**
   * GET /workflows/executions/:id
   * Returns the current status of a workflow execution (RUNNING, COMPLETED, CANCELLED).
   */
  @Get('executions/:id')
  getExecution(@Param('id') id: string) {
    return this.workflowsService.getExecution(id);
  }
}
