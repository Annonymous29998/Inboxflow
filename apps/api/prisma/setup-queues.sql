-- Supabase Queues (pgmq) — replaces Redis/BullMQ
-- Enable "Queues" in Supabase Dashboard → Integrations first (installs pgmq).

CREATE EXTENSION IF NOT EXISTS pgmq;

DO $$ BEGIN PERFORM pgmq.create('email-send'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('campaign-dispatch'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('bounce-process'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "SmtpHourlySent" (
  provider_id TEXT NOT NULL,
  hour_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_id, hour_key)
);

ALTER TABLE "SmtpHourlySent" ENABLE ROW LEVEL SECURITY;
