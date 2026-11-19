export function isSqliteDatabase(): boolean {
  return String(process.env.DATABASE_URL || '').startsWith('file:');
}

export function isDesktopHybrid(): boolean {
  return process.env.DESKTOP_HYBRID === '1';
}

/** EXE on this PC / RDP: send in the local Node process, not the browser tab. */
export function usesInProcessSend(): boolean {
  return isSqliteDatabase() || process.env.INBOXFLOW_DESKTOP === '1';
}
