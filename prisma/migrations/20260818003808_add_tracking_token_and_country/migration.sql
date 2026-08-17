-- Add trackingToken to Message for first-party pixel/click tracking.
-- The token is a URL-safe HMAC-SHA256 value generated at send time.
-- It is the lookup key for /t/o/:token and /t/c/:token endpoints.
ALTER TABLE "Message" ADD COLUMN "trackingToken" TEXT;
CREATE UNIQUE INDEX "Message_trackingToken_key" ON "Message"("trackingToken");

-- Add country to Event for privacy-safe geo tracking.
-- Only the ISO-3166-1 alpha-2 country code is stored; the source IP is discarded.
ALTER TABLE "Event" ADD COLUMN "country" TEXT;
