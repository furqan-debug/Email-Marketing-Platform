-- Add firstName and lastName columns to Contact (optional)
ALTER TABLE "Contact" ADD COLUMN "firstName" TEXT;
ALTER TABLE "Contact" ADD COLUMN "lastName" TEXT;

-- Create Template model table
CREATE TABLE "Template" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "subject" TEXT,
  "html" TEXT NOT NULL
);
