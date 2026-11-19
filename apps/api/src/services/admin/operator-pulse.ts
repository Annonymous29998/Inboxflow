export type OperatorPulseCampaign = {
  id: string;
  name: string;
  status: string;
  sentCount: number;
  openedCount: number;
  updatedAt: string;
  userName?: string;
  userEmail?: string;
};

export type OperatorPulse = {
  lastSeenAt: string;
  sending: number;
  campaignsSent: number;
  emailsSent: number;
  emailsFailed: number;
  recentCampaigns: OperatorPulseCampaign[];
};

const EMPTY: OperatorPulse = {
  lastSeenAt: '',
  sending: 0,
  campaignsSent: 0,
  emailsSent: 0,
  emailsFailed: 0,
  recentCampaigns: [],
};

function asInt(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function asCampaign(raw: unknown): OperatorPulseCampaign | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const id = String(c.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(c.name || 'Untitled').slice(0, 160),
    status: String(c.status || 'DRAFT').slice(0, 32),
    sentCount: asInt(c.sentCount),
    openedCount: asInt(c.openedCount),
    updatedAt: String(c.updatedAt || new Date().toISOString()).slice(0, 40),
    userName: String(c.userName || '').slice(0, 120) || undefined,
    userEmail: String(c.userEmail || '').slice(0, 160) || undefined,
  };
}

export function readOperatorPulse(sendSettings: unknown): OperatorPulse {
  const settings =
    sendSettings && typeof sendSettings === 'object' ? (sendSettings as Record<string, unknown>) : {};
  const raw = settings.operatorPulse;
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const p = raw as Record<string, unknown>;
  const recent = Array.isArray(p.recentCampaigns)
    ? p.recentCampaigns.map(asCampaign).filter((c): c is OperatorPulseCampaign => Boolean(c)).slice(0, 8)
    : [];
  return {
    lastSeenAt: String(p.lastSeenAt || ''),
    sending: asInt(p.sending),
    campaignsSent: asInt(p.campaignsSent),
    emailsSent: asInt(p.emailsSent),
    emailsFailed: asInt(p.emailsFailed),
    recentCampaigns: recent,
  };
}

export function readAdminNote(sendSettings: unknown): string {
  const settings =
    sendSettings && typeof sendSettings === 'object' ? (sendSettings as Record<string, unknown>) : {};
  return String(settings.adminNote || '').slice(0, 500);
}

export function mergeAdminNote(sendSettings: unknown, adminNote: string): Record<string, unknown> {
  const prev =
    sendSettings && typeof sendSettings === 'object' ? { ...(sendSettings as Record<string, unknown>) } : {};
  prev.adminNote = adminNote.slice(0, 500);
  return prev;
}

export function mergeOperatorPulse(sendSettings: unknown, pulse: OperatorPulse): Record<string, unknown> {
  const prev =
    sendSettings && typeof sendSettings === 'object' ? { ...(sendSettings as Record<string, unknown>) } : {};
  prev.operatorPulse = pulse;
  return prev;
}

export function sumPulses(pulses: OperatorPulse[]): Omit<OperatorPulse, 'lastSeenAt' | 'recentCampaigns'> & {
  recentCampaigns: OperatorPulseCampaign[];
} {
  const recent: OperatorPulseCampaign[] = [];
  let sending = 0;
  let campaignsSent = 0;
  let emailsSent = 0;
  let emailsFailed = 0;
  for (const p of pulses) {
    sending += p.sending;
    campaignsSent += p.campaignsSent;
    emailsSent += p.emailsSent;
    emailsFailed += p.emailsFailed;
    recent.push(...p.recentCampaigns);
  }
  recent.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    sending,
    campaignsSent,
    emailsSent,
    emailsFailed,
    recentCampaigns: recent.slice(0, 8),
  };
}

export { EMPTY as EMPTY_OPERATOR_PULSE };
