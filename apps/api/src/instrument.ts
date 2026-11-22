import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import * as Sentry from '@sentry/node';

const envCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '../../../.env'),
];
for (const path of envCandidates) {
  if (existsSync(path)) dotenvConfig({ path });
}
dotenvConfig();

const dsn = String(process.env.SENTRY_DSN || '').trim();
const prod = process.env.NODE_ENV === 'production';

if (dsn) {
  Sentry.init({
    dsn,
    environment: prod ? 'production' : 'development',
    dataCollection: { userInfo: false },
    tracesSampleRate: prod ? 0.1 : 1.0,
    integrations: [Sentry.fastifyIntegration()],
    beforeSend(event) {
      const msg = `${event.message || ''} ${event.exception?.values?.[0]?.value || ''}`;
      if (/WORKSPACE_ON_DEVICE|Open Inbox Flow on this PC/i.test(msg)) return null;
      if (event.request) {
        delete event.request.data;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });
}

export { Sentry };
