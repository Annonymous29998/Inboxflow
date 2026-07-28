-- Inbox Flow feature columns (performance rotation, pools, DKIM, minute limits)
-- Safe to re-run.

ALTER TABLE "EmailProvider" ADD COLUMN IF NOT EXISTS "successCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EmailProvider" ADD COLUMN IF NOT EXISTS "failCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EmailProvider" ADD COLUMN IF NOT EXISTS "minuteLimit" INTEGER;

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "subjectPool" JSONB;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "fromNamePool" JSONB;

ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "dkimSelector" TEXT;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "dkimPrivateKeyEnc" TEXT;

CREATE TABLE IF NOT EXISTS "SmtpMinuteSent" (
  provider_id TEXT NOT NULL,
  minute_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_id, minute_key)
);

ALTER TABLE "SmtpMinuteSent" ENABLE ROW LEVEL SECURITY;
