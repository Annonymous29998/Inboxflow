export const DEMO_MAILER_USER = 'demo';
export const DEMO_MAILER_LICENSE = 'IF-A7K2-M9QP-4XDW';
export const DEMO_MAILER_NAME = 'demo';
export const DEMO_MAILER_WORKSPACE = 'Demo Workspace';
export const DEMO_MAILER_IP = '203.0.113.40';
export const DEMO_MAILER_ID = 'demo-mailer-user';
export const DEMO_ACCESS_TOKEN = 'demo-access';
export const DEMO_REFRESH_TOKEN = 'demo-refresh';

/** Local Vite only — operator + admin website (never in production builds). */
export const DEMO_STAFF_USER = 'operator';
export const DEMO_STAFF_LICENSE = 'IF-OP-K7M2-9Q4X';
export const DEMO_STAFF_ID = 'demo-staff-user';
export const DEMO_STAFF_ACCESS_TOKEN = 'demo-staff-access';
export const DEMO_STAFF_REFRESH_TOKEN = 'demo-staff-refresh';

export const MAILER_UI_DEMO = false;

export function isDemoIdentity(userId?: string | null, accessToken?: string | null) {
  return (
    userId === DEMO_MAILER_ID ||
    userId === DEMO_STAFF_ID ||
    accessToken === DEMO_ACCESS_TOKEN ||
    accessToken === DEMO_STAFF_ACCESS_TOKEN ||
    accessToken === DEMO_REFRESH_TOKEN ||
    accessToken === DEMO_STAFF_REFRESH_TOKEN
  );
}

/** Drop leftover demo sessions so mailer/admin always hit the live API. */
export function purgeStaleDemoSession(): boolean {
  if (MAILER_UI_DEMO || typeof window === 'undefined') return false;
  let found = false;
  try {
    const keys = ['inboxflow-auth', 'inboxflow-auth-fallback'];
    for (const key of keys) {
      for (const store of [window.localStorage, window.sessionStorage]) {
        const raw = store.getItem(key);
        if (!raw) continue;
        if (
          raw.includes(DEMO_MAILER_ID) ||
          raw.includes(DEMO_STAFF_ID) ||
          raw.includes(DEMO_ACCESS_TOKEN) ||
          raw.includes(DEMO_STAFF_ACCESS_TOKEN)
        ) {
          store.removeItem(key);
          found = true;
        }
      }
    }
    window.sessionStorage.removeItem('inboxflow-demo-workspace');
    window.sessionStorage.removeItem('inboxflow-demo-workspace-v');
    window.sessionStorage.removeItem('inboxflow-demo-bound');
  } catch {
    /* ignore */
  }
  return found;
}

const BOUND_KEY = 'inboxflow-demo-bound';

export function isDemoMailerLogin(username: string, license: string) {
  return (
    MAILER_UI_DEMO &&
    username.trim().toLowerCase() === DEMO_MAILER_USER &&
    license.trim().toUpperCase() === DEMO_MAILER_LICENSE
  );
}

export function isDemoStaffLogin(username: string, license: string) {
  const user = username.trim().toLowerCase();
  return (
    MAILER_UI_DEMO &&
    (user === DEMO_STAFF_USER || user === 'admin') &&
    license.trim().toUpperCase() === DEMO_STAFF_LICENSE
  );
}

export function demoStaffUser() {
  return {
    id: DEMO_STAFF_ID,
    email: 'operator@inboxflow.io',
    firstName: 'Operator',
    lastName: '',
    role: 'SUPER_ADMIN',
    organizationId: 'demo-staff-org',
    status: 'ACTIVE',
    organization: {
      id: 'demo-staff-org',
      name: 'Inbox Flow',
      slug: 'inboxflow',
      physicalAddress: '1 Operator Street',
    },
    smtpAllowDirect: true,
    workspaceLocal: false,
    boundIp: null,
  };
}

export function readDemoBound(): { boundIp: string; validUntil: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(BOUND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { boundIp?: string; validUntil?: string };
    if (!parsed.validUntil) return null;
    return { boundIp: parsed.boundIp || '203.0.113.40', validUntil: parsed.validUntil };
  } catch {
    return null;
  }
}

export function writeDemoBound(boundIp: string, validUntil: string) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(BOUND_KEY, JSON.stringify({ boundIp, validUntil }));
}

export function clearDemoBound() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(BOUND_KEY);
}

export function demoMailerUser(boundIp: string) {
  return {
    id: DEMO_MAILER_ID,
    email: `${DEMO_MAILER_USER}@inboxflow.io`,
    firstName: DEMO_MAILER_NAME,
    lastName: '',
    role: 'USER',
    organizationId: 'demo-org',
    status: 'ACTIVE',
    organization: {
      id: 'demo-org',
      name: DEMO_MAILER_WORKSPACE,
      slug: 'demo',
      physicalAddress: '1 Demo Street, Remote',
    },
    smtpAllowDirect: false,
    workspaceLocal: true,
    boundIp: boundIp || null,
  };
}
