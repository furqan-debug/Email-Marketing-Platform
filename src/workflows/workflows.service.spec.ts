import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import {
  WorkflowsService,
  WorkflowExecutionStatus,
} from './workflows.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Mock factories ─────────────────────────────────────────────────────────────

const mockContactFindUnique: jest.Mock           = jest.fn();
const mockSuppressionFindUnique: jest.Mock         = jest.fn();
const mockWorkflowExecutionCreate: jest.Mock     = jest.fn();
const mockWorkflowExecutionFindUnique: jest.Mock = jest.fn();
const mockWorkflowExecutionUpdate: jest.Mock     = jest.fn();

const mockPrisma = {
  contact:           { findUnique: mockContactFindUnique },
  suppression:       { findUnique: mockSuppressionFindUnique },
  workflowExecution: {
    create: mockWorkflowExecutionCreate,
    findUnique: mockWorkflowExecutionFindUnique,
    update: mockWorkflowExecutionUpdate,
  },
};

const mockWorkflowQueueAdd: jest.Mock = jest.fn();
const mockWorkflowQueue = { add: mockWorkflowQueueAdd };

const mockEmailQueueAdd: jest.Mock = jest.fn();
const mockEmailQueue = { add: mockEmailQueueAdd };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contactId   = 'contact-123';
const workspaceId = 'workspace-456';
const email       = 'user@example.com';
const executionId = 'execution-789';

const mockContact = {
  id: contactId,
  email,
  firstName: 'Alice',
  lastName: 'Smith',
  audience: { workspaceId },
};

const mockExecutionRunning = {
  id: executionId,
  workflowType: 'WELCOME_SERIES',
  contactId,
  status: WorkflowExecutionStatus.RUNNING,
  currentStep: 1,
  contact: mockContact,
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('WorkflowsService', () => {
  let service: WorkflowsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken('workflow'), useValue: mockWorkflowQueue },
        { provide: getQueueToken('email'), useValue: mockEmailQueue },
      ],
    }).compile();

    service = module.get<WorkflowsService>(WorkflowsService);
    jest.clearAllMocks();
  });

  // ── triggerWelcomeSeries ───────────────────────────────────────────────────

  describe('triggerWelcomeSeries', () => {
    it('creates WorkflowExecution and enqueues Step 1 immediately', async () => {
      mockContactFindUnique.mockResolvedValue(mockContact);
      mockSuppressionFindUnique.mockResolvedValue(null); // not suppressed
      mockWorkflowExecutionCreate.mockResolvedValue(mockExecutionRunning);

      const result = await service.triggerWelcomeSeries(contactId);

      expect(result.status).toBe(WorkflowExecutionStatus.RUNNING);
      expect(mockWorkflowExecutionCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contactId,
          status: WorkflowExecutionStatus.RUNNING,
          currentStep: 1,
        }),
      });
      expect(mockWorkflowQueueAdd).toHaveBeenCalledWith(
        'execute-step',
        { executionId: result.id, stepNumber: 1 },
        { delay: 0 },
      );
    });

    it('cancels execution immediately if contact is suppressed at trigger time', async () => {
      mockContactFindUnique.mockResolvedValue(mockContact);
      mockSuppressionFindUnique.mockResolvedValue({ id: 'sup-1', email }); // SUPPRESSED
      mockWorkflowExecutionCreate.mockResolvedValue({
        ...mockExecutionRunning,
        status: WorkflowExecutionStatus.CANCELLED,
      });

      const result = await service.triggerWelcomeSeries(contactId);

      expect(result.status).toBe(WorkflowExecutionStatus.CANCELLED);
      expect(mockWorkflowQueueAdd).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if contact does not exist', async () => {
      mockContactFindUnique.mockResolvedValue(null);

      await expect(service.triggerWelcomeSeries('bad-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── executeStep ───────────────────────────────────────────────────────────

  describe('executeStep', () => {
    it('Step 1: sends Email 1, advances to Step 2, and schedules Step 2 with delay', async () => {
      mockWorkflowExecutionFindUnique.mockResolvedValue(mockExecutionRunning);
      mockSuppressionFindUnique.mockResolvedValue(null); // not suppressed
      mockEmailQueueAdd.mockResolvedValue({});
      mockWorkflowExecutionUpdate.mockResolvedValue({});
      mockWorkflowQueueAdd.mockResolvedValue({});

      const result = await service.executeStep(executionId, 1);

      expect(result.status).toBe('EXECUTED');
      expect(mockEmailQueueAdd).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({
          to: email,
          subject: 'Welcome to our platform!',
        }),
      );
      expect(mockWorkflowExecutionUpdate).toHaveBeenCalledWith({
        where: { id: executionId },
        data: { currentStep: 2 },
      });
      expect(mockWorkflowQueueAdd).toHaveBeenCalledWith(
        'execute-step',
        { executionId, stepNumber: 2 },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it('Step 3: sends Email 3 and marks workflow COMPLETED (no further steps scheduled)', async () => {
      mockWorkflowExecutionFindUnique.mockResolvedValue({
        ...mockExecutionRunning,
        currentStep: 3,
      });
      mockSuppressionFindUnique.mockResolvedValue(null);
      mockEmailQueueAdd.mockResolvedValue({});
      mockWorkflowExecutionUpdate.mockResolvedValue({});

      const result = await service.executeStep(executionId, 3);

      expect(result.status).toBe('EXECUTED');
      expect(mockEmailQueueAdd).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({
          to: email,
          subject: 'Advanced features & support',
        }),
      );
      expect(mockWorkflowExecutionUpdate).toHaveBeenCalledWith({
        where: { id: executionId },
        data: { status: WorkflowExecutionStatus.COMPLETED },
      });
      expect(mockWorkflowQueueAdd).not.toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // CRITICAL TEST: MID-WORKFLOW UNSUBSCRIBE
    // ─────────────────────────────────────────────────────────────────────────
    it('CRITICAL: mid-workflow unsubscribe cancels execution, skips email send, and halts remaining steps', async () => {
      // Step 1 previously succeeded. Execution is now at Step 2.
      mockWorkflowExecutionFindUnique.mockResolvedValue({
        ...mockExecutionRunning,
        currentStep: 2,
      });

      // Contact HAS UNSUBSCRIBED / been added to Suppression list before Step 2 runs!
      mockSuppressionFindUnique.mockResolvedValue({
        id: 'sup-101',
        workspaceId,
        email,
      });

      mockWorkflowExecutionUpdate.mockResolvedValue({});

      const result = await service.executeStep(executionId, 2);

      // 1. Status returned must indicate mid-workflow cancellation
      expect(result.status).toBe('CANCELLED_SUPPRESSED');

      // 2. WorkflowExecution status in DB must be updated to CANCELLED
      expect(mockWorkflowExecutionUpdate).toHaveBeenCalledWith({
        where: { id: executionId },
        data: { status: WorkflowExecutionStatus.CANCELLED },
      });

      // 3. NO email must be enqueued for Step 2!
      expect(mockEmailQueueAdd).not.toHaveBeenCalled();

      // 4. NO future steps (Step 3) must be scheduled!
      expect(mockWorkflowQueueAdd).not.toHaveBeenCalled();
    });

    it('skips execution if workflow is already CANCELLED', async () => {
      mockWorkflowExecutionFindUnique.mockResolvedValue({
        ...mockExecutionRunning,
        status: WorkflowExecutionStatus.CANCELLED,
      });

      const result = await service.executeStep(executionId, 2);

      expect(result.status).toBe('ALREADY_CANCELLED');
      expect(mockEmailQueueAdd).not.toHaveBeenCalled();
    });

    it('skips execution if workflow is already COMPLETED', async () => {
      mockWorkflowExecutionFindUnique.mockResolvedValue({
        ...mockExecutionRunning,
        status: WorkflowExecutionStatus.COMPLETED,
      });

      const result = await service.executeStep(executionId, 3);

      expect(result.status).toBe('ALREADY_COMPLETED');
      expect(mockEmailQueueAdd).not.toHaveBeenCalled();
    });
  });

  // ── getExecution ─────────────────────────────────────────────────────────

  describe('getExecution', () => {
    it('returns workflow execution details', async () => {
      mockWorkflowExecutionFindUnique.mockResolvedValue(mockExecutionRunning);

      const result = await service.getExecution(executionId);

      expect(result.id).toBe(executionId);
      expect(result.contact.email).toBe(email);
    });

    it('throws NotFoundException if execution not found', async () => {
      mockWorkflowExecutionFindUnique.mockResolvedValue(null);

      await expect(service.getExecution('bad-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
