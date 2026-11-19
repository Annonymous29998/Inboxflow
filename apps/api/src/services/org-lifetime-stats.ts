import { prisma } from '../config/prisma.js';

export type OrgLifetimeStats = {
  sent: number;
  delivered: number;
  failed: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
};

const EMPTY: OrgLifetimeStats = {
  sent: 0,
  delivered: 0,
  failed: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
};

type SendSettings = {
  lifetimeStats?: Partial<OrgLifetimeStats>;
  [key: string]: unknown;
};

function asInt(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function readLifetimeStats(sendSettings: unknown): OrgLifetimeStats {
  const raw = ((sendSettings || {}) as SendSettings).lifetimeStats || {};
  return {
    sent: asInt(raw.sent),
    delivered: asInt(raw.delivered),
    failed: asInt(raw.failed),
    opened: asInt(raw.opened),
    clicked: asInt(raw.clicked),
    bounced: asInt(raw.bounced),
    complained: asInt(raw.complained),
  };
}

export async function addOrgLifetimeStats(organizationId: string, delta: Partial<OrgLifetimeStats>) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { sendSettings: true },
  });
  if (!org) return;
  const prev = (org.sendSettings && typeof org.sendSettings === 'object' ? org.sendSettings : {}) as SendSettings;
  const cur = readLifetimeStats(prev);
  const next: OrgLifetimeStats = {
    sent: cur.sent + asInt(delta.sent),
    delivered: cur.delivered + asInt(delta.delivered),
    failed: cur.failed + asInt(delta.failed),
    opened: cur.opened + asInt(delta.opened),
    clicked: cur.clicked + asInt(delta.clicked),
    bounced: cur.bounced + asInt(delta.bounced),
    complained: cur.complained + asInt(delta.complained),
  };
  await prisma.organization.update({
    where: { id: organizationId },
    data: { sendSettings: { ...prev, lifetimeStats: next } },
  });
}

export { EMPTY as EMPTY_LIFETIME_STATS };
