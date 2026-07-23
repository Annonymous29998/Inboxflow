import { buildApp } from './app.js';
import { env } from './config/env.js';
import { startWorkers } from './services/email/queue.js';

async function main() {
  const app = await buildApp();

  // Background queue workers are optional. Nexlogs-style sending uses browser sequential
  // delivery + Supabase Edge Functions — set RUN_WORKERS=true only if you use pgmq queues.
  if (process.env.RUN_WORKERS === 'true') {
    startWorkers();
  }

  // Railway (and most hosts) inject PORT — prefer it over API_PORT.
  const port = Number(process.env.PORT) || env.API_PORT;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`${env.APP_NAME} API listening on :${port}`);
  console.log(`API docs: http://localhost:${port}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
