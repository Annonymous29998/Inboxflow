/** A saved login can be refused once while the app is opening, then accepted. */
export function isUnauthorizedError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) return true;
  const message = err instanceof Error ? err.message : '';
  return message.trim().toLowerCase() === 'unauthorized';
}
