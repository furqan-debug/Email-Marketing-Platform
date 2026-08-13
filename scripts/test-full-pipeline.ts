import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../prisma/generated/client/client';
import { Queue, QueueEvents } from 'bullmq';

async function run() {
  console.log('🚀 Starting Full Send Pipeline Test...\n');

  // 1. Initialize Prisma with Postgres adapter
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required in .env');
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter } as any);

  try {
    // 2. Create Workspace -> Audience -> Contact & Campaign -> Message
    const workspace = await (prisma as any).workspace.create({
      data: { name: 'Pipeline Test Workspace' },
    });
    console.log(`✅ Created Workspace: ${workspace.id}`);

    const audience = await (prisma as any).audience.create({
      data: {
        name: 'Pipeline Test Audience',
        workspaceId: workspace.id,
      },
    });
    console.log(`✅ Created Audience: ${audience.id}`);

    const recipientEmail = process.env.AWS_SES_TEST_RECIPIENT || 'developer@digireps.co';
    const contact = await (prisma as any).contact.create({
      data: {
        email: recipientEmail,
        audienceId: audience.id,
      },
    });
    console.log(`✅ Created Contact: ${contact.id} (${contact.email})`);

    const campaign = await (prisma as any).campaign.create({
      data: {
        name: 'Pipeline Test Campaign',
        audienceId: audience.id,
      },
    });
    console.log(`✅ Created Campaign: ${campaign.id}`);

    const initialMessage = await (prisma as any).message.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
      },
    });
    console.log(`\n📬 Created Message in DB with initial ID: ${initialMessage.id}`);

    // 3. Connect to BullMQ Queue & QueueEvents
    const connection = { host: 'localhost', port: 6379 };
    const emailQueue = new Queue('email', { connection });
    const queueEvents = new QueueEvents('email', { connection });

    // 4. Enqueue Job
    console.log(`⏳ Enqueuing job to BullMQ 'email' queue...`);
    const job = await emailQueue.add('send', {
      to: contact.email,
      subject: 'Full Send Pipeline Test',
      html: '<p>Testing full pipeline: Workspace -> Audience -> Contact & Campaign -> Message -> Worker -> SES -> Webhook!</p>',
      messageId: initialMessage.id,
    });

    console.log(`📋 Enqueued Job ID: ${job.id}`);

    // 5. Wait for Worker to process job
    console.log(`⏳ Waiting for worker to process job...`);
    const result = await job.waitUntilFinished(queueEvents);

    console.log(`\n🎉 Worker Finished Processing Job!`);
    console.log(`   - Initial Message DB ID : ${initialMessage.id}`);
    console.log(`   - Returned SES MessageId: ${result.providerId}`);

    // 6. Verify Message row ID in DB
    const updatedMessage = await (prisma as any).message.findUnique({
      where: { id: result.providerId },
    });

    if (updatedMessage) {
      console.log(`\n✅ Verified Message ID in DB updated to SES MessageId: ${updatedMessage.id}`);
      console.log(`   Webhooks will now successfully match incoming SES events (Delivery, Bounce, Open, Click) to this Message!`);
    } else {
      console.log(`\n⚠️ Message with ID ${result.providerId} not found in DB.`);
    }

    await emailQueue.close();
    await queueEvents.close();
  } finally {
    await (prisma as any).$disconnect?.();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('❌ Pipeline Test Failed:', err);
  process.exit(1);
});
