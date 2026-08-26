import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../../prisma/generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * PrismaService wraps PrismaClient (Prisma v7) using the required pg driver adapter.
 * Uses composition rather than inheritance because Prisma 7's generated client
 * is ESM-first and cannot be extended via `class X extends PrismaClient`.
 *
 * Exposes `client` for raw access, plus convenience proxies for each model
 * so callers can write `this.prisma.event.create(...)` as expected.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;
  private readonly pool: Pool;

  constructor() {
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_PUBLIC_URL ||
      process.env.DATABASE_PRIVATE_URL;

    // AWS RDS (and most remote databases) require SSL.
    // Disable SSL only for localhost / 127.0.0.1 (local dev).
    const isLocal =
      connectionString?.includes('localhost') ||
      connectionString?.includes('127.0.0.1');

    this.pool = new Pool({
      connectionString,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
    const adapter = new PrismaPg(this.pool);
    this.client = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
  }

  async onModuleInit() {
    await (this.client as any).$connect();

    // Auto-sync sequence tables and columns on startup
    try {
      await this.pool.query(`
        ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "isSequence" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "trackOpens" BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "trackClicks" BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "stepNumber" INTEGER NOT NULL DEFAULT 1;



        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_campaignId_contactId_key') THEN
            ALTER TABLE "Message" DROP CONSTRAINT "Message_campaignId_contactId_key";
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_campaignId_contactId_stepNumber_key') AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'Message_campaignId_contactId_stepNumber_key') THEN
            CREATE UNIQUE INDEX "Message_campaignId_contactId_stepNumber_key" ON "Message"("campaignId", "contactId", "stepNumber");
          END IF;
        END $$;

        CREATE TABLE IF NOT EXISTS "CampaignStep" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "campaignId" TEXT NOT NULL REFERENCES "Campaign"("id") ON DELETE CASCADE,
          "stepOrder" INTEGER NOT NULL,
          "delayHours" DOUBLE PRECISION NOT NULL DEFAULT 48,
          "scheduledAt" TIMESTAMP(3),
          "sendAtTime" TEXT,
          "sendAsReply" BOOLEAN NOT NULL DEFAULT true,
          "subject" TEXT,
          "htmlBody" TEXT NOT NULL,
          "templateId" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "CampaignStep_campaignId_stepOrder_key" UNIQUE ("campaignId", "stepOrder")
        );

        ALTER TABLE "CampaignStep" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);
        ALTER TABLE "CampaignStep" ADD COLUMN IF NOT EXISTS "sendAtTime" TEXT;
        ALTER TABLE "AnalyticsSnapshot" ADD COLUMN IF NOT EXISTS "replied" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "AnalyticsSnapshot" ADD COLUMN IF NOT EXISTS "unsubscribed" INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE IF NOT EXISTS "CampaignLead" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "campaignId" TEXT NOT NULL REFERENCES "Campaign"("id") ON DELETE CASCADE,
          "contactId" TEXT NOT NULL REFERENCES "Contact"("id") ON DELETE CASCADE,
          "currentStep" INTEGER NOT NULL DEFAULT 1,
          "status" TEXT NOT NULL DEFAULT 'ACTIVE',
          "rootMessageId" TEXT,
          "lastSentAt" TIMESTAMP(3),
          "nextSendAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "CampaignLead_campaignId_contactId_key" UNIQUE ("campaignId", "contactId")
        );

        CREATE INDEX IF NOT EXISTS "CampaignLead_status_nextSendAt_idx" ON "CampaignLead"("status", "nextSendAt");
      `);
    } catch (err: any) {
      console.warn('Auto-migration notice in onModuleInit:', err?.message);
    }

  }


  async onModuleDestroy() {
    await (this.client as any).$disconnect();
    await this.pool.end();
  }

  // Model proxies — add more as new models are used across the app
  get workspace()         { return (this.client as any).workspace; }
  get audience()          { return (this.client as any).audience; }
  get contact()           { return (this.client as any).contact; }
  get campaign()          { return (this.client as any).campaign; }
  get message()           { return (this.client as any).message; }
  get event()             { return (this.client as any).event; }
  get suppression()       { return (this.client as any).suppression; }
  get template()          { return (this.client as any).template; }
  get analyticsSnapshot() { return (this.client as any).analyticsSnapshot; }
  get campaignStep()      { return (this.client as any).campaignStep; }
  get campaignLead()      { return (this.client as any).campaignLead; }
  get workflowExecution() { return (this.client as any).workflowExecution; }


  // Transaction helper
  get $transaction()      { return this.client.$transaction.bind(this.client); }
}
