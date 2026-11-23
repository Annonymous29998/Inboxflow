import './instrument.js';
import * as Sentry from '@sentry/node';
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { isDesktopHybrid } from './config/db-kind.js';
import { ensureSqliteSchema } from './config/sqlite-schema.js';
import { ensureRelayTables } from './services/email/tracking-relay.js';
import { startWorkers } from './services/email/queue.js';
import { startInboxFlowSmtpServer } from './services/email/inboxflow-smtp.js';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  Sentry.captureException(reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  Sentry.captureException(err);
  const desktop = isDesktopHybrid() || process.env.INBOXFLOW_DESKTOP === '1';
  if (!desktop) process.exit(1);
});

// Railway: trigger watched-filter redeploy so skipped railway.json + /health-first fixes actually apply.

async function main() {
  await ensureSqliteSchema();
  await ensureRelayTables().catch((error) => {
    console.error('Tracking relay tables were not ready:', error);
  });
  const app = await buildApp();

  // Background queue workers are optional. Nexlogs-style sending uses browser sequential
  // delivery + Supabase Edge Functions — set RUN_WORKERS=true only if you use pgmq queues.
  if (process.env.RUN_WORKERS === 'true') {
    startWorkers();
  }

  // Railway (and most hosts) inject PORT — prefer it over API_PORT.
  const port = Number(process.env.PORT) || env.API_PORT;
  const host = isDesktopHybrid() ? '127.0.0.1' : '0.0.0.0';
  await app.listen({ port, host });
  console.log(`${env.APP_NAME} API listening on :${port}`);
  const { resolvePublicBaseUrl } = await import('./services/email/public-url.js');
  const publicUrl = resolvePublicBaseUrl({
    publicUrl: env.PUBLIC_URL,
    trackingBaseUrl: env.TRACKING_BASE_URL,
    apiUrl: env.API_URL,
  });
  console.log(`Tracking / opens / clicks: ${publicUrl}`);
  console.log(`API docs: http://localhost:${port}/docs`);
  try {
    await startInboxFlowSmtpServer();
  } catch (err) {
    console.error('Inbox Flow SMTP listener did not start:', err);
  }
}

main().catch((err) => {
  console.error(err);
  Sentry.captureException(err);
  process.exit(1);
});
