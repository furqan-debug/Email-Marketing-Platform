-- Add unique constraint on Contact(audienceId, email) for workspace-scoped dedup.
-- Existing duplicate rows (if any) must be resolved before this runs.
CREATE UNIQUE INDEX "Contact_audienceId_email_key" ON "Contact"("audienceId", "email");

-- Add the Suppression model for blocking suppressed contacts at message-generation time.
-- keyed by (workspaceId, email) — checked in bulk when generating campaign messages.
CREATE TABLE "Suppression" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Suppression_workspaceId_email_key" ON "Suppression"("workspaceId", "email");

ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
