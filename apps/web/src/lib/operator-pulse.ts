import { api } from '@/lib/api';
import { isMailerTenant } from '@/lib/roles';

type CampaignRow = {
  id: string;
  name?: string;
  status?: string;
  sentCount?: number;
  openedCount?: number;
  failedCount?: number;
  updatedAt?: string;
};

type PulseBody = {
  sending: number;
  campaignsSent: number;
  emailsSent: number;
  emailsFailed: number;
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    sentCount: number;
    openedCount: number;
    updatedAt: string;
  }>;
};

let lastAt = 0;
let inFlight = false;
let lastBody: PulseBody | null = null;

function emptyBody(): PulseBody {
  return {
    sending: 0,
    campaignsSent: 0,
    emailsSent: 0,
    emailsFailed: 0,
    recentCampaigns: [],
  };
}

/** Heartbeat + send totals. Lists, HTML, and SMTP stay on the device. Never throws. */
export async function reportWorkspacePulse(role?: string | null) {
  if (!isMailerTenant(role)) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (inFlight) return;
  const now = Date.now();
  if (now - lastAt < 15_000) return;
  lastAt = now;
  inFlight = true;

  let body = lastBody || emptyBody();
  try {
    const data = await api.get<{ campaigns: CampaignRow[] }>('/api/campaigns?limit=50');
    const campaigns = data.campaigns || [];
    body = {
      sending: campaigns.filter((c) => c.status === 'SENDING').length,
      campaignsSent: campaigns.filter((c) => c.status === 'SENT').length,
      emailsSent: campaigns.reduce((n, c) => n + (c.sentCount || 0), 0),
      emailsFailed: campaigns.reduce((n, c) => n + (c.failedCount || 0), 0),
      recentCampaigns: campaigns.slice(0, 8).map((c) => ({
        id: c.id,
        name: c.name || 'Untitled',
        status: c.status || 'DRAFT',
        sentCount: c.sentCount || 0,
        openedCount: c.openedCount || 0,
        updatedAt: c.updatedAt || new Date().toISOString(),
      })),
    };
    lastBody = body;
  } catch {
    /* Keep last totals. Still stamp lastSeen so admin can show presence. */
  }

  try {
    await api.post('/api/workspace/pulse', body, { timeoutMs: 6_000 });
  } catch {
    /* API down: local send continues. Admin will show Stale PC. */
  } finally {
    inFlight = false;
  }
}

/** Pull opens, clicks, and unsubscribes recorded on the public site into this PC. */
export async function pullTrackingRelay(role?: string | null) {
  if (!isMailerTenant(role)) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  if (host !== 'localhost' && host !== '127.0.0.1') return;
  try {
    const data = await api.get<{
      events: Array<{
        id: string;
        campaignId: string;
        contactId: string;
        email?: string | null;
        type: 'OPENED' | 'CLICKED' | 'UNSUBSCRIBED';
      }>;
    }>('/api/workspace/tracking-events');
    const events = data.events || [];
    if (!events.length) return;
    await api.post('/api/campaigns/tracking-apply', { events }, { timeoutMs: 12_000 });
    await api.post(
      '/api/workspace/tracking-events/ack',
      { ids: events.map((event) => event.id) },
      { timeoutMs: 8_000 },
    );
  } catch {
    /* Public site unreachable. Local send still works. The next poll retries. */
  }
}
