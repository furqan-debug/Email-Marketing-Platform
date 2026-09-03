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
        ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE "Audience" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
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

    // Inbox tables
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS "InboxThread" (
          "id"           TEXT NOT NULL PRIMARY KEY,
          "campaignId"   TEXT NOT NULL REFERENCES "Campaign"("id") ON DELETE CASCADE,
          "contactId"    TEXT NOT NULL REFERENCES "Contact"("id") ON DELETE CASCADE,
          "contactEmail" TEXT NOT NULL,
          "contactName"  TEXT,
          "subject"      TEXT,
          "status"       TEXT NOT NULL DEFAULT 'unread',
          "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "InboxThread_campaignId_contactId_key" UNIQUE ("campaignId", "contactId")
        );

        CREATE TABLE IF NOT EXISTS "InboxMessage" (
          "id"        TEXT NOT NULL PRIMARY KEY,
          "threadId"  TEXT NOT NULL REFERENCES "InboxThread"("id") ON DELETE CASCADE,
          "direction" TEXT NOT NULL,
          "fromEmail" TEXT NOT NULL,
          "toEmail"   TEXT NOT NULL,
          "subject"   TEXT,
          "body"      TEXT NOT NULL,
          "sentAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS "InboxThread_status_idx" ON "InboxThread"("status");
        CREATE INDEX IF NOT EXISTS "InboxThread_updatedAt_idx" ON "InboxThread"("updatedAt");
        CREATE INDEX IF NOT EXISTS "InboxMessage_threadId_idx" ON "InboxMessage"("threadId");

        -- Clean up duplicate messages
        DELETE FROM "InboxMessage"
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY "threadId", "body" ORDER BY "sentAt" ASC) as rnum
            FROM "InboxMessage"
          ) t
          WHERE t.rnum > 1
        );
      `);
    } catch (inboxErr: any) {
      console.warn('Inbox table migration notice:', inboxErr?.message);
    }


    // Historical date backfill for existing campaigns
    try {
      await this.pool.query(`
        UPDATE "Campaign" SET "createdAt" = '2026-09-04 01:11:00' WHERE "name" = 'Q3 Sales Outreach Y';
        UPDATE "Campaign" SET "createdAt" = '2026-09-04 00:52:00' WHERE "name" = 'Q3 Sales Outreach x';
        UPDATE "Campaign" SET "createdAt" = '2026-09-03 22:30:00' WHERE "name" = '3-Sep-Check(3)';
        UPDATE "Campaign" SET "createdAt" = '2026-09-03 15:30:00' WHERE "name" = '3-Sep-Check(2)';
        UPDATE "Campaign" SET "createdAt" = '2026-09-03 15:13:00' WHERE "name" = '3-Sep-Check';
        UPDATE "Campaign" SET "createdAt" = '2026-09-02 22:00:00' WHERE "name" = '2-Sep-SN(3)';
        UPDATE "Campaign" SET "createdAt" = '2026-09-02 20:00:00' WHERE "name" = '2-Sep-SN(2)';
        UPDATE "Campaign" SET "createdAt" = '2026-09-02 18:00:00' WHERE "name" = '2-Sep-SN';
        UPDATE "Campaign" SET "createdAt" = '2026-09-01 16:00:00' WHERE "name" = 'Q3 Sales Outreach';
        UPDATE "Campaign" SET "createdAt" = '2026-08-31 15:19:00' WHERE "name" = '31-Aug-SN-Test';
        UPDATE "Campaign" SET "createdAt" = '2026-08-28 16:08:00' WHERE "name" = '28-Aug-Test-2';
        UPDATE "Campaign" SET "createdAt" = '2026-08-28 15:08:00' WHERE "name" = '28-Aug-Test';
        UPDATE "Campaign" SET "createdAt" = '2026-08-26 20:09:00' WHERE "name" = '26-Aug-SN';
        UPDATE "Campaign" SET "createdAt" = '2026-08-26 20:07:00' WHERE "name" = '26-Open Rate Again Test';
        UPDATE "Campaign" SET "createdAt" = '2026-08-26 20:05:00' WHERE "name" = '26-Open Rate-Checking';
        UPDATE "Campaign" SET "createdAt" = '2026-08-25 18:00:00' WHERE "name" = '25-Aug-SN-Daniel';
        UPDATE "Campaign" SET "createdAt" = '2026-08-25 16:00:00' WHERE "name" = '25-Aug Testing 2';
        UPDATE "Campaign" SET "createdAt" = '2026-08-25 15:00:00' WHERE "name" = '25-Aug-Test 1st Campaign';
        UPDATE "Campaign" SET "createdAt" = '2026-08-24 18:00:00' WHERE "name" = 'Test Campaign 4.7';
        UPDATE "Campaign" SET "createdAt" = '2026-08-24 17:00:00' WHERE "name" = 'Test Campaign 4.6';
        UPDATE "Campaign" SET "createdAt" = '2026-08-24 16:00:00' WHERE "name" = 'Test Campaign 4.5';
        UPDATE "Campaign" SET "createdAt" = '2026-08-24 15:00:00' WHERE "name" = 'DigiReps Beta Testing';
        UPDATE "Campaign" SET "createdAt" = '2026-08-24 14:00:00' WHERE "name" = 'Summer Product Update';
        UPDATE "Campaign" SET "createdAt" = '2026-08-24 13:00:00' WHERE "name" = 'test campaign (let''s) issue';
      `);
    } catch (backfillErr: any) {
      console.warn('Campaign backfill notice in onModuleInit:', backfillErr?.message);
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
  get inboxThread()       { return (this.client as any).inboxThread; }
  get inboxMessage()      { return (this.client as any).inboxMessage; }

  // Transaction helper
  get $transaction()      { return this.client.$transaction.bind(this.client); }
}

