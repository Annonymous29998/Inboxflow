const PLATFORM_ADMIN_EMAIL = String(process.env.PLATFORM_ADMIN_EMAIL || 'admin@inboxflow.com')
  .toLowerCase()
  .trim();

const DEVICE_WORKSPACE_PREFIXES = [
  '/api/contacts',
  '/api/lists',
  '/api/segments',
  '/api/campaigns',
  '/api/templates',
  '/api/providers',
  '/api/domains',
  '/api/import',
  '/api/logs',
  '/api/jobs',
  '/api/analytics',
  '/api/deliverability',
];

export function isPlatformOperator(input: { role?: string | null; email?: string | null }): boolean {
  const role = String(input.role || '');
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return true;
  const email = String(input.email || '').toLowerCase().trim();
  return Boolean(PLATFORM_ADMIN_EMAIL && email === PLATFORM_ADMIN_EMAIL);
}

/** Admin-created workspaces keep contacts/campaigns/SMTP on the user's PC. */
export function orgKeepsWorkspaceOnDevice(input: {
  sendSettings?: unknown;
  role?: string | null;
  email?: string | null;
}): boolean {
  if (isPlatformOperator(input)) return false;
  const settings =
    input.sendSettings && typeof input.sendSettings === 'object'
      ? (input.sendSettings as Record<string, unknown>)
      : {};
  if (settings.workspaceLocal === true) return true;
  if (settings.smtpAllowDirect === false) return true;
  return false;
}

export function isDeviceWorkspacePath(urlPath: string): boolean {
  const path = String(urlPath || '').split('?')[0] || '';
  if (path.startsWith('/api/admin/organization')) return true;
  return DEVICE_WORKSPACE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function isCloudHostedApi(): boolean {
  return process.env.DESKTOP_HYBRID !== '1' && process.env.INBOXFLOW_DESKTOP !== '1';
}

export const WORKSPACE_ON_DEVICE_MESSAGE = 'Open Inbox Flow on this PC to continue.';
