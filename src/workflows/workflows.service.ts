import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const WorkflowType = {
  WELCOME_SERIES: 'WELCOME_SERIES',
} as const;

export const WorkflowExecutionStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export interface WorkflowJobData {
  executionId: string;
  stepNumber: number;
}

const STEP_TEMPLATES = {
  1: { subject: 'Welcome to our platform!', html: '<p>Welcome! We are excited to have you.</p>' },
  2: { subject: 'Getting started tips', html: '<p>Here are 3 quick tips to get started.</p>' },
  3: { subject: 'Advanced features & support', html: '<p>Discover advanced features and support resources.</p>' },
};

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('workflow') private readonly workflowQueue: Queue,
    @InjectQueue('email') private readonly emailQueue: Queue,
  ) {}

  /**
   * Triggers the 3-step Welcome Series workflow for a contact.
   *
   * Verifies the contact is not currently suppressed before starting.
   * Schedules Step 1 immediately (delay 0).
   */
  async triggerWelcomeSeries(contactId: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        audience: {
          select: { workspaceId: true },
        },
      },
    });

    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }

    const workspaceId = contact.audience.workspaceId;

    // Check suppression list at trigger time
    const suppression = await this.prisma.suppression.findUnique({
      where: {
        workspaceId_email: {
          workspaceId,
          email: contact.email.toLowerCase(),
        },
      },
    });

    if (suppression) {
      this.logger.log(
        `Contact ${contact.email} is suppressed — Welcome Series trigger cancelled at start`,
      );
      const execution = await this.prisma.workflowExecution.create({
        data: {
          workflowType: WorkflowType.WELCOME_SERIES,
          contactId,
          status: WorkflowExecutionStatus.CANCELLED,
          currentStep: 1,
        },
      });
      return execution;
    }

    // Create execution state
    const execution = await this.prisma.workflowExecution.create({
      data: {
        workflowType: WorkflowType.WELCOME_SERIES,
        contactId,
        status: WorkflowExecutionStatus.RUNNING,
        currentStep: 1,
      },
    });

    this.logger.log(
      `Triggered Welcome Series execution ${execution.id} for contact ${contact.email}`,
    );

    // Schedule Step 1 immediately
    await this.workflowQueue.add(
      'execute-step',
      { executionId: execution.id, stepNumber: 1 },
      { delay: 0 },
    );

    return execution;
  }

  /**
   * Executes a single step of the Welcome Series workflow.
   *
   * Mid-Workflow Unsubscribe Rule:
   * Re-checks suppression list BEFORE executing the step action.
   * If the contact has unsubscribed / been suppressed mid-workflow,
   * execution is CANCELLED immediately, no email is sent, and no future
   * steps are scheduled.
   */
  async executeStep(executionId: string, stepNumber: number) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id: executionId },
      include: {
        contact: {
          include: {
            audience: { select: { workspaceId: true } },
          },
        },
      },
    });

    if (!execution) {
      this.logger.error(`executeStep: Workflow execution ${executionId} not found`);
      return { status: 'NOT_FOUND' };
    }

    if (execution.status === WorkflowExecutionStatus.CANCELLED) {
      this.logger.log(
        `Workflow execution ${executionId} is already CANCELLED — skipping Step ${stepNumber}`,
      );
      return { status: 'ALREADY_CANCELLED' };
    }

    if (execution.status === WorkflowExecutionStatus.COMPLETED) {
      this.logger.log(
        `Workflow execution ${executionId} is already COMPLETED — skipping Step ${stepNumber}`,
      );
      return { status: 'ALREADY_COMPLETED' };
    }

    const { contact } = execution;
    const workspaceId = contact.audience.workspaceId;

    // ─────────────────────────────────────────────────────────────────────────
    // MID-WORKFLOW SUPPRESSION CHECK (Enforced BEFORE executing every step)
    // ─────────────────────────────────────────────────────────────────────────
    const suppression = await this.prisma.suppression.findUnique({
      where: {
        workspaceId_email: {
          workspaceId,
          email: contact.email.toLowerCase(),
        },
      },
    });

    if (suppression) {
      this.logger.log(
        `🚫 Mid-workflow unsubscribe detected! Contact ${contact.email} is suppressed at Step ${stepNumber}. Cancelling workflow execution ${executionId}.`,
      );

      // Cancel execution immediately
      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: { status: WorkflowExecutionStatus.CANCELLED },
      });

      // Do NOT send email and do NOT schedule next step!
      return { status: 'CANCELLED_SUPPRESSED' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXECUTE STEP ACTION (Send Welcome Email N)
    // ─────────────────────────────────────────────────────────────────────────
    const stepConfig = STEP_TEMPLATES[stepNumber as keyof typeof STEP_TEMPLATES];
    if (!stepConfig) {
      this.logger.error(`Invalid step number ${stepNumber} for Welcome Series`);
      return { status: 'INVALID_STEP' };
    }

    this.logger.log(
      `Executing Step ${stepNumber} for Welcome Series execution ${executionId} (Contact: ${contact.email})`,
    );

    // Enqueue email job to BullMQ 'email' queue
    await this.emailQueue.add('send', {
      to: contact.email,
      subject: stepConfig.subject,
      html: stepConfig.html,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ADVANCE OR COMPLETE WORKFLOW
    // ─────────────────────────────────────────────────────────────────────────
    if (stepNumber < 3) {
      const nextStep = stepNumber + 1;

      // Update current step in DB
      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: { currentStep: nextStep },
      });

      // Compute delay for next step
      // Default: 24h for step 2, 48h for step 3. Can be overridden via env var for testing.
      const overrideDelay = process.env.WORKFLOW_STEP_DELAY_MS
        ? parseInt(process.env.WORKFLOW_STEP_DELAY_MS, 10)
        : null;

      const delayMs =
        overrideDelay ??
        (nextStep === 2 ? 24 * 60 * 60 * 1000 : 48 * 60 * 60 * 1000);

      this.logger.log(
        `Scheduling Step ${nextStep} for execution ${executionId} in ${delayMs}ms`,
      );

      await this.workflowQueue.add(
        'execute-step',
        { executionId, stepNumber: nextStep },
        { delay: delayMs },
      );
    } else {
      // Step 3 complete — mark workflow COMPLETED
      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: { status: WorkflowExecutionStatus.COMPLETED },
      });

      this.logger.log(
        `🎉 Welcome Series execution ${executionId} for contact ${contact.email} COMPLETED!`,
      );
    }

    return { status: 'EXECUTED', stepNumber };
  }

  /**
   * Fetches a workflow execution by ID.
   */
  async getExecution(executionId: string) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id: executionId },
      include: {
        contact: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    if (!execution) {
      throw new NotFoundException(`Workflow execution ${executionId} not found`);
    }

    return execution;
  }
}
