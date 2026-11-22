import { useEffect } from 'react';

/** Dev-only page: throws so the React SDK can be verified in Sentry. */
export function SentryTestErrorPage() {
  useEffect(() => {
    throw new Error(`Sentry test error ${Date.now()}`);
  }, []);
  return <p className="p-6 font-mono text-sm">Sending a test error…</p>;
}
