-- Add status column to Campaign with default 'DRAFT'
ALTER TABLE "Campaign" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- Add enqueuedAt column to Message (nullable — null = not yet enqueued)
ALTER TABLE "Message" ADD COLUMN "enqueuedAt" TIMESTAMP(3);

-- Add unique constraint on Message(campaignId, contactId)
-- This makes generateMessages idempotent: createMany(skipDuplicates:true) becomes safe.
CREATE UNIQUE INDEX "Message_campaignId_contactId_key" ON "Message"("campaignId", "contactId");
