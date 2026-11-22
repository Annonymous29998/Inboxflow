/** Layout fixtures for local Vite only. Production builds always hit the live API. */
export const ADMIN_UI_DEMO = false;

function ago(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function ahead(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

export type DemoSubscription = {
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  active: boolean;
};

export type DemoUser = {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  role: 'USER';
  status: 'ACTIVE' | 'SUSPENDED';
  lastLoginAt: string | null;
  createdAt: string;
  organization: { name: string };
  adminNote?: string;
  onDevice: boolean;
  boundIp?: string | null;
  boundAt?: string | null;
  licenseBound?: boolean;
  subscription: DemoSubscription;
  pulse: {
    lastSeenAt: string | null;
    sending: number;
    campaignsSent: number;
    emailsSent: number;
    emailsFailed: number;
    recentCampaigns: DemoCampaign[];
  };
};

export type DemoSession = {
  id: string;
  userAgent: string;
  ipAddress: string;
  createdAt: string;
  expiresAt: string;
  current?: boolean;
};

export const DEMO_SESSIONS: Record<string, DemoSession[]> = {
  'demo-user-nova': [
    {
      id: 'demo-sess-nova-1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ipAddress: '102.89.23.14',
      createdAt: ago(40_000),
      expiresAt: ahead(7 * 86400000),
      current: true,
    },
    {
      id: 'demo-sess-nova-2',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ipAddress: '102.89.23.18',
      createdAt: ago(3 * 86400000),
      expiresAt: ago(2 * 86400000),
      current: false,
    },
  ],
  'demo-user-acme': [
    {
      id: 'demo-sess-acme-1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ipAddress: '41.210.11.90',
      createdAt: ago(8 * 60000),
      expiresAt: ahead(6 * 86400000),
      current: true,
    },
  ],
  'demo-user-harbor': [
    {
      id: 'demo-sess-harbor-1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ipAddress: '80.12.44.2',
      createdAt: ago(90_000),
      expiresAt: ahead(7 * 86400000),
      current: true,
    },
  ],
  'demo-user-westline': [
    {
      id: 'demo-sess-west-1',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      ipAddress: '185.22.10.4',
      createdAt: ago(3 * 3600000),
      expiresAt: ago(3600000),
      current: false,
    },
  ],
  'demo-user-pixel': [
    {
      id: 'demo-sess-pixel-1',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ipAddress: '197.251.1.22',
      createdAt: ago(5 * 86400000),
      expiresAt: ago(4 * 86400000),
      current: false,
    },
  ],
  'demo-user-north': [
    {
      id: 'demo-sess-north-1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
      ipAddress: '154.72.8.40',
      createdAt: ago(20 * 60000),
      expiresAt: ahead(7 * 86400000),
      current: true,
    },
  ],
  'demo-user-kite': [
    {
      id: 'demo-sess-kite-1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ipAddress: '105.112.3.9',
      createdAt: ago(2 * 86400000),
      expiresAt: ago(86400000),
      current: false,
    },
  ],
  'demo-user-lumen': [
    {
      id: 'demo-sess-lumen-1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ipAddress: '51.15.22.88',
      createdAt: ago(70_000),
      expiresAt: ahead(7 * 86400000),
      current: true,
    },
  ],
};

export type DemoCampaign = {
  id: string;
  name: string;
  status: string;
  sentCount: number;
  openedCount: number;
  organization: { name: string };
  user: { username: string; name: string; email: string };
  updatedAt: string;
};

export const DEMO_USERS: DemoUser[] = [
  {
    id: 'demo-mailer-user',
    email: 'demo@inboxflow.io',
    username: 'demo',
    firstName: 'demo',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(20_000),
    createdAt: ago(2 * 86400000),
    organization: { name: 'Demo Workspace' },
    onDevice: true,
    boundIp: null,
    licenseBound: false,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(2 * 86400000),
      currentPeriodEnd: ahead(28 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(20_000),
      sending: 0,
      campaignsSent: 0,
      emailsSent: 0,
      emailsFailed: 0,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-nova',
    email: 'nova@inboxflow.io',
    username: 'nova',
    firstName: 'nova',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(40_000),
    createdAt: ago(12 * 86400000),
    organization: { name: 'Nova Outreach' },
    adminNote: 'Paid cash Nov 10. Prefers 465.',
    onDevice: true,
    boundIp: null,
    licenseBound: false,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(8 * 86400000),
      currentPeriodEnd: ahead(22 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(25_000),
      sending: 1,
      campaignsSent: 18,
      emailsSent: 48210,
      emailsFailed: 126,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-acme',
    email: 'acme-mail@inboxflow.io',
    username: 'acme-mail',
    firstName: 'acme-mail',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(8 * 60000),
    createdAt: ago(40 * 86400000),
    organization: { name: 'Acme Billing' },
    onDevice: true,
    boundIp: null,
    licenseBound: false,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(12 * 86400000),
      currentPeriodEnd: ahead(48 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(6 * 60000),
      sending: 0,
      campaignsSent: 42,
      emailsSent: 128_440,
      emailsFailed: 890,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-harbor',
    email: 'harbor@inboxflow.io',
    username: 'harbor',
    firstName: 'harbor',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(90_000),
    createdAt: ago(6 * 86400000),
    organization: { name: 'Harbor Studio' },
    onDevice: false,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(24 * 86400000),
      currentPeriodEnd: ahead(6 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(50_000),
      sending: 1,
      campaignsSent: 9,
      emailsSent: 12_804,
      emailsFailed: 44,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-west',
    email: 'westline@inboxflow.io',
    username: 'westline',
    firstName: 'westline',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(3 * 3600000),
    createdAt: ago(21 * 86400000),
    organization: { name: 'Westline Logistics' },
    adminNote: 'Asked to renew after invoice.',
    onDevice: true,
    subscription: {
      status: 'EXPIRED',
      currentPeriodStart: ago(34 * 86400000),
      currentPeriodEnd: ago(4 * 86400000),
      active: false,
    },
    pulse: {
      lastSeenAt: ago(3 * 3600000),
      sending: 0,
      campaignsSent: 27,
      emailsSent: 76_012,
      emailsFailed: 310,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-pixel',
    email: 'pixel-ops@inboxflow.io',
    username: 'pixel-ops',
    firstName: 'pixel-ops',
    lastName: '',
    role: 'USER',
    status: 'SUSPENDED',
    lastLoginAt: ago(5 * 86400000),
    createdAt: ago(90 * 86400000),
    organization: { name: 'Pixel Ops' },
    onDevice: false,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(19 * 86400000),
      currentPeriodEnd: ahead(11 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(5 * 86400000),
      sending: 0,
      campaignsSent: 4,
      emailsSent: 2_210,
      emailsFailed: 88,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-north',
    email: 'northstar@inboxflow.io',
    username: 'northstar',
    firstName: 'northstar',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(20 * 60000),
    createdAt: ago(3 * 86400000),
    organization: { name: 'Northstar Mail' },
    onDevice: true,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(2 * 86400000),
      currentPeriodEnd: ahead(28 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(18 * 60000),
      sending: 0,
      campaignsSent: 6,
      emailsSent: 9_441,
      emailsFailed: 19,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-kite',
    email: 'kite@inboxflow.io',
    username: 'kite',
    firstName: 'kite',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(2 * 86400000),
    createdAt: ago(14 * 86400000),
    organization: { name: 'Kite Retail' },
    onDevice: true,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(28 * 86400000),
      currentPeriodEnd: ahead(2 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(2 * 86400000),
      sending: 0,
      campaignsSent: 11,
      emailsSent: 33_900,
      emailsFailed: 201,
      recentCampaigns: [],
    },
  },
  {
    id: 'demo-user-lumen',
    email: 'lumen@inboxflow.io',
    username: 'lumen',
    firstName: 'lumen',
    lastName: '',
    role: 'USER',
    status: 'ACTIVE',
    lastLoginAt: ago(70_000),
    createdAt: ago(2 * 86400000),
    organization: { name: 'Lumen Agency' },
    onDevice: false,
    subscription: {
      status: 'ACTIVE',
      currentPeriodStart: ago(15 * 86400000),
      currentPeriodEnd: ahead(15 * 86400000),
      active: true,
    },
    pulse: {
      lastSeenAt: ago(45_000),
      sending: 0,
      campaignsSent: 3,
      emailsSent: 4_180,
      emailsFailed: 12,
      recentCampaigns: [],
    },
  },
];

export const DEMO_CAMPAIGNS: DemoCampaign[] = [
  {
    id: 'demo-camp-1',
    name: 'Nov 16 billing reminder',
    status: 'SENDING',
    sentCount: 1840,
    openedCount: 412,
    organization: { name: 'Nova Outreach' },
    user: { username: 'nova', name: 'nova', email: 'nova@inboxflow.io' },
    updatedAt: ago(12 * 60000),
  },
  {
    id: 'demo-camp-2',
    name: 'Q4 product update',
    status: 'SENT',
    sentCount: 9200,
    openedCount: 2104,
    organization: { name: 'Harbor Studio' },
    user: { username: 'harbor', name: 'harbor', email: 'harbor@inboxflow.io' },
    updatedAt: ago(40 * 60000),
  },
  {
    id: 'demo-camp-3',
    name: 'Invoice follow-up batch B',
    status: 'PAUSED',
    sentCount: 640,
    openedCount: 88,
    organization: { name: 'Acme Billing' },
    user: { username: 'acme-mail', name: 'acme-mail', email: 'acme-mail@inboxflow.io' },
    updatedAt: ago(3 * 3600000),
  },
  {
    id: 'demo-camp-4',
    name: 'Welcome series — week 1',
    status: 'SENT',
    sentCount: 3102,
    openedCount: 980,
    organization: { name: 'Westline Logistics' },
    user: { username: 'westline', name: 'westline', email: 'westline@inboxflow.io' },
    updatedAt: ago(8 * 3600000),
  },
  {
    id: 'demo-camp-5',
    name: 'Black Friday warm-up',
    status: 'SENT',
    sentCount: 15400,
    openedCount: 4022,
    organization: { name: 'Kite Retail' },
    user: { username: 'kite', name: 'kite', email: 'kite@inboxflow.io' },
    updatedAt: ago(26 * 3600000),
  },
  {
    id: 'demo-camp-6',
    name: 'Studio digest #48',
    status: 'FAILED',
    sentCount: 120,
    openedCount: 0,
    organization: { name: 'Lumen Agency' },
    user: { username: 'lumen', name: 'lumen', email: 'lumen@inboxflow.io' },
    updatedAt: ago(2 * 86400000),
  },
];

export const DEMO_LOGS = [
  { id: 'demo-log-1', action: 'USER_CREATED', resource: 'user:nova', createdAt: ago(12 * 86400000) },
  { id: 'demo-log-2', action: 'LICENSE_ISSUED', resource: 'user:harbor', createdAt: ago(6 * 86400000) },
  { id: 'demo-log-3', action: 'USER_LOGIN', resource: 'user:nova', createdAt: ago(40_000) },
  { id: 'demo-log-4', action: 'CAMPAIGN_SEND', resource: 'campaign:Nov 16 billing reminder', createdAt: ago(12 * 60000) },
  { id: 'demo-log-5', action: 'USER_SUSPENDED', resource: 'user:pixel-ops', createdAt: ago(5 * 86400000) },
  { id: 'demo-log-6', action: 'USER_LOGIN', resource: 'user:lumen', createdAt: ago(70_000) },
  { id: 'demo-log-7', action: 'CAMPAIGN_PAUSED', resource: 'campaign:Invoice follow-up batch B', createdAt: ago(3 * 3600000) },
  { id: 'demo-log-8', action: 'USER_CREATED', resource: 'user:northstar', createdAt: ago(3 * 86400000) },
  { id: 'demo-log-9', action: 'SMTP_TEST_OK', resource: 'workspace:Harbor Studio', createdAt: ago(2 * 3600000) },
  { id: 'demo-log-10', action: 'USER_LOGIN', resource: 'user:harbor', createdAt: ago(90_000) },
  { id: 'demo-log-11', action: 'USER_LOGIN', resource: 'user:acme-mail', createdAt: ago(8 * 60000) },
  { id: 'demo-log-12', action: 'LICENSE_ISSUED', resource: 'user:lumen', createdAt: ago(2 * 86400000) },
  { id: 'demo-log-13', action: 'CAMPAIGN_SEND', resource: 'campaign:Q4 product update', createdAt: ago(40 * 60000) },
  { id: 'demo-log-14', action: 'USER_CREATED', resource: 'user:kite', createdAt: ago(14 * 86400000) },
  { id: 'demo-log-15', action: 'SMTP_TEST_OK', resource: 'workspace:Nova Outreach', createdAt: ago(50_000) },
];

function readSharedDemoBind(): { boundIp: string; validUntil: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem('inboxflow-demo-bound');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { boundIp?: string; validUntil?: string };
    if (!parsed.boundIp) return null;
    return { boundIp: parsed.boundIp, validUntil: parsed.validUntil || '' };
  } catch {
    return null;
  }
}

export function hydrateDemoUsers(): DemoUser[] {
  const demoBind = readSharedDemoBind();
  return DEMO_USERS.map((u) => {
    const isDemoMailer = u.id === 'demo-mailer-user' || u.username === 'demo';
    const boundIp = isDemoMailer ? demoBind?.boundIp || null : u.boundIp || null;
    return {
      ...u,
      boundIp,
      boundAt: isDemoMailer ? demoBind?.validUntil || null : u.boundAt,
      licenseBound: Boolean(boundIp),
      pulse: {
        ...u.pulse,
        recentCampaigns: DEMO_CAMPAIGNS.filter((c) => c.user.username === u.username),
      },
    };
  });
}

export function demoOverview() {
  const users = hydrateDemoUsers();
  return {
    health: { status: 'ok', database: 'up' },
    stats: {
      users: users.length,
      workspaces: new Set(users.map((u) => u.organization.name)).size,
      sending: users.reduce((n, u) => n + u.pulse.sending, 0),
      online: users.filter((u) => Date.now() - Date.parse(u.pulse.lastSeenAt || '') < 2 * 60 * 1000).length,
      sent: users.reduce((n, u) => n + u.pulse.campaignsSent, 0),
      emailsSent: users.reduce((n, u) => n + u.pulse.emailsSent, 0),
      emailsFailed: users.reduce((n, u) => n + u.pulse.emailsFailed, 0),
    },
    recentUsers: users.slice(0, 8),
    recentCampaigns: DEMO_CAMPAIGNS,
  };
}

export function isDemoId(id?: string) {
  if (!ADMIN_UI_DEMO) return false;
  return Boolean(id && id.startsWith('demo-'));
}

export function bumpSubscription(
  sub: { currentPeriodStart?: string; currentPeriodEnd?: string } | undefined,
  months: number,
): DemoSubscription {
  const now = Date.now();
  const currentEnd = sub?.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : 0;
  const base = new Date(currentEnd > now ? currentEnd : now);
  base.setMonth(base.getMonth() + months);
  const start = sub?.currentPeriodStart && currentEnd > now ? sub.currentPeriodStart : new Date().toISOString();
  return {
    status: 'ACTIVE',
    currentPeriodStart: start,
    currentPeriodEnd: base.toISOString(),
    active: true,
  };
}
