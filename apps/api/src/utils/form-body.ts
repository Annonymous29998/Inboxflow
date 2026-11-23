/** application/x-www-form-urlencoded body. Gmail and Microsoft POST this for one-click unsubscribe. */
export function parseUrlEncodedBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(String(body || ''));
  for (const [key, value] of params) out[key] = value;
  return out;
}
