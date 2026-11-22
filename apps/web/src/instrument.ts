import * as Sentry from '@sentry/react';

const dsn = String(import.meta.env.VITE_SENTRY_DSN || '').trim();
const prod = import.meta.env.PROD;

if (dsn) {
  Sentry.init({
    dsn,
    environment: prod ? 'production' : 'development',
    dataCollection: { userInfo: false },
    tracesSampleRate: prod ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    tracePropagationTargets: [/^\//, /^https:\/\/novasreach\.xyz/i, /^https:\/\/[^/]*inboxflow\.io/i],
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    beforeSend(event) {
      const msg = `${event.message || ''} ${event.exception?.values?.[0]?.value || ''}`;
      if (/WORKSPACE_ON_DEVICE|Open Inbox Flow on this PC/i.test(msg)) return null;
      return event;
    },
  });
}
