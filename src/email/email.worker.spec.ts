import { Test, TestingModule } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { EmailModule } from './email.module';

describe('EmailWorker Integration', () => {
  let moduleRef: TestingModule;
  let emailQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: {
            host: 'localhost',
            port: 6379,
          },
        }),
        EmailModule,
      ],
    }).compile();

    await moduleRef.init();
    emailQueue = moduleRef.get<Queue>(getQueueToken('email'));
    // Clean up queue before test
    await emailQueue.drain();
  });

  afterAll(async () => {
    await emailQueue.drain();
    await emailQueue.close();
    await moduleRef.close();
  });

  it('should enqueue 3 fake sends and process them returning providerIds', async () => {
    const job1 = await emailQueue.add('send', { to: 'test1@example.com', subject: 'Test 1', html: '<p>1</p>' });
    const job2 = await emailQueue.add('send', { to: 'test2@example.com', subject: 'Test 2', html: '<p>2</p>' });
    const job3 = await emailQueue.add('send', { to: 'test3@example.com', subject: 'Test 3', html: '<p>3</p>' });

    // Wait for jobs to complete
    const waitForJob = async (job: Job) => {
      let state = await job.getState();
      while (state !== 'completed' && state !== 'failed') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await job.getState();
      }
      if (state === 'failed') {
        throw new Error(`Job ${job.id} failed`);
      }
      const updatedJob = await Job.fromId(emailQueue, job.id!);
      return updatedJob!.returnvalue;
    };

    const result1 = await waitForJob(job1);
    const result2 = await waitForJob(job2);
    const result3 = await waitForJob(job3);

    expect(result1).toHaveProperty('providerId');
    expect(result2).toHaveProperty('providerId');
    expect(result3).toHaveProperty('providerId');
    
    expect(result1.providerId).toMatch(/^fake-/);
    expect(result2.providerId).toMatch(/^fake-/);
    expect(result3.providerId).toMatch(/^fake-/);
  }, 10000);
});
