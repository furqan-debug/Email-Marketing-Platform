-- Migration: add_campaign_content_and_unique_analytics

-- Campaign: add email content fields
ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "subject"    TEXT,
  ADD COLUMN IF NOT EXISTS "fromName"   TEXT,
  ADD COLUMN IF NOT EXISTS "htmlBody"   TEXT,
  ADD COLUMN IF NOT EXISTS "templateId" TEXT;

-- Campaign: add FK to Template (optional / nullable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Campaign_templateId_fkey'
  ) THEN
    ALTER TABLE "Campaign"
      ADD CONSTRAINT "Campaign_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "Template"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AnalyticsSnapshot: add total (non-unique) open/click counters
ALTER TABLE "AnalyticsSnapshot"
  ADD COLUMN IF NOT EXISTS "totalOpens"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalClicks" INTEGER NOT NULL DEFAULT 0;
