-- Create AnalyticsSnapshot table — one row per campaign, upserted by the aggregation job.
-- Dashboard reads exclusively from this table; no live aggregation queries run at request time.
CREATE TABLE "AnalyticsSnapshot" (
    "id"         TEXT         NOT NULL,
    "campaignId" TEXT         NOT NULL,
    "sent"       INTEGER      NOT NULL DEFAULT 0,
    "delivered"  INTEGER      NOT NULL DEFAULT 0,
    "opened"     INTEGER      NOT NULL DEFAULT 0,
    "clicked"    INTEGER      NOT NULL DEFAULT 0,
    "bounced"    INTEGER      NOT NULL DEFAULT 0,
    "complained" INTEGER      NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- One snapshot per campaign
CREATE UNIQUE INDEX "AnalyticsSnapshot_campaignId_key" ON "AnalyticsSnapshot"("campaignId");

-- FK to Campaign
ALTER TABLE "AnalyticsSnapshot"
    ADD CONSTRAINT "AnalyticsSnapshot_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
