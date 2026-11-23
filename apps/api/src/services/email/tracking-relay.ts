import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { isSqliteDatabase } from '../../config/db-kind.js';
import { cloudTrackingOrigin } from './public-url.js';
import {
  encodeRelayClickTicket,
  signRelayOpen,
  signRelayUnsubscribe,
} from '../../utils/signed-urls.js';

export type RelayEvent = {
  id: string;
  organizationId: string;
  campaignId: string;
  contactId: string;
  email: string | null;
  type: 'OPENED' | 'CLICKED' | 'UNSUBSCRIBED';
  url: string | null;
  createdAt: string;
};

let ready: Promise<void> | null = null;

export function ensureRelayTables(): Promise<void> {
  if (isSqliteDatabase()) return Promise.resolve();
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TrackingLink" (
          "id" TEXT PRIMARY KEY,
          "organizationId" TEXT NOT NULL,
          "campaignId" TEXT NOT NULL,
          "contactId" TEXT NOT NULL,
          "email" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "TrackingLink_org_campaign_contact" UNIQUE ("organizationId", "campaignId", "contactId")
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TrackingRelayEvent" (
          "id" TEXT PRIMARY KEY,
          "organizationId" TEXT NOT NULL,
          "campaignId" TEXT NOT NULL,
          "contactId" TEXT NOT NULL,
          "email" TEXT,
          "type" TEXT NOT NULL,
          "url" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "ackedAt" TIMESTAMPTZ
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "TrackingRelayEvent_org_ack"
        ON "TrackingRelayEvent" ("organizationId", "ackedAt")
      `);
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

export async function rememberRelayLink(input: {
  organizationId: string;
  campaignId: string;
  contactId: string;
  email?: string | null;
}) {
  await ensureRelayTables();
  const email = String(input.email || '').trim().toLowerCase() || null;
  await prisma.$executeRaw`
    INSERT INTO "TrackingLink" ("id", "organizationId", "campaignId", "contactId", "email", "createdAt")
    VALUES (${randomUUID()}, ${input.organizationId}, ${input.campaignId}, ${input.contactId}, ${email}, NOW())
    ON CONFLICT ("organizationId", "campaignId", "contactId")
    DO UPDATE SET "email" = COALESCE(EXCLUDED."email", "TrackingLink"."email")
  `;
}

export async function recordRelayEvent(input: {
  organizationId: string;
  campaignId: string;
  contactId: string;
  type: RelayEvent['type'];
  url?: string | null;
}) {
  await ensureRelayTables();
  const existing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "TrackingRelayEvent"
    WHERE "organizationId" = ${input.organizationId}
      AND "campaignId" = ${input.campaignId}
      AND "contactId" = ${input.contactId}
      AND "type" = ${input.type}
    LIMIT 1
  `;
  if (existing.length) return;
  const links = await prisma.$queryRaw<Array<{ email: string | null }>>`
    SELECT "email" FROM "TrackingLink"
    WHERE "organizationId" = ${input.organizationId}
      AND "campaignId" = ${input.campaignId}
      AND "contactId" = ${input.contactId}
    LIMIT 1
  `;
  const email = links[0]?.email || null;
  await prisma.$executeRaw`
    INSERT INTO "TrackingRelayEvent"
      ("id", "organizationId", "campaignId", "contactId", "email", "type", "url", "createdAt")
    VALUES (
      ${randomUUID()},
      ${input.organizationId},
      ${input.campaignId},
      ${input.contactId},
      ${email},
      ${input.type},
      ${input.url || null},
      NOW()
    )
  `;
}

export async function listRelayEvents(organizationId: string): Promise<RelayEvent[]> {
  await ensureRelayTables();
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      organizationId: string;
      campaignId: string;
      contactId: string;
      email: string | null;
      type: string;
      url: string | null;
      createdAt: Date;
    }>
  >`
    SELECT "id", "organizationId", "campaignId", "contactId", "email", "type", "url", "createdAt"
    FROM "TrackingRelayEvent"
    WHERE "organizationId" = ${organizationId} AND "ackedAt" IS NULL
    ORDER BY "createdAt" ASC
    LIMIT 200
  `;
  return rows
    .filter((row) => row.type === 'OPENED' || row.type === 'CLICKED' || row.type === 'UNSUBSCRIBED')
    .map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      campaignId: row.campaignId,
      contactId: row.contactId,
      email: row.email,
      type: row.type as RelayEvent['type'],
      url: row.url,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
}

export async function ackRelayEvents(organizationId: string, ids: string[]) {
  await ensureRelayTables();
  const clean = ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 200);
  if (!clean.length) return;
  await prisma.$executeRaw`
    UPDATE "TrackingRelayEvent"
    SET "ackedAt" = NOW()
    WHERE "organizationId" = ${organizationId}
      AND "ackedAt" IS NULL
      AND "id" IN (${Prisma.join(clean)})
  `;
}

export type MintedRelay = {
  origin: string;
  openSig: string;
  unsubSig: string;
  tickets: Record<string, string>;
};

/** Ask the public site to sign this recipient. Contacts stay on the PC. */
export async function mintRelayTracking(input: {
  authorization?: string | null;
  organizationId: string;
  campaignId: string;
  contactId: string;
  email?: string | null;
  urls: string[];
}): Promise<MintedRelay> {
  const origin = cloudTrackingOrigin();
  const authorization = String(input.authorization || '').trim();
  if (!authorization) {
    throw new Error('Sign in again so open and unsubscribe links can use the public site.');
  }
  const res = await fetch(`${origin}/api/workspace/tracking-mint`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      campaignId: input.campaignId,
      contactId: input.contactId,
      email: input.email || undefined,
      urls: input.urls.slice(0, 30),
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error('The public tracking site did not sign this message. The send was not sent with a :5000 link.');
  }
  const data = (await res.json()) as MintedRelay;
  if (!data.openSig || !data.unsubSig) {
    throw new Error('The public tracking site returned an incomplete link.');
  }
  return {
    origin: String(data.origin || origin).replace(/\/$/, ''),
    openSig: data.openSig,
    unsubSig: data.unsubSig,
    tickets: data.tickets || {},
  };
}

export async function applyRelayEventsLocal(
  organizationId: string,
  events: RelayEvent[],
): Promise<number> {
  let applied = 0;
  for (const event of events) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: event.campaignId, organizationId },
      select: { id: true },
    });
    if (!campaign) continue;
    if (event.type === 'OPENED') {
      const updated = await prisma.campaignRecipient.updateMany({
        where: { campaignId: event.campaignId, contactId: event.contactId, openedAt: null },
        data: { openedAt: new Date(), status: 'OPENED' },
      });
      if (updated.count > 0) {
        await prisma.campaign.update({
          where: { id: event.campaignId },
          data: { openedCount: { increment: updated.count } },
        });
        applied += updated.count;
      }
    } else if (event.type === 'CLICKED') {
      const updated = await prisma.campaignRecipient.updateMany({
        where: { campaignId: event.campaignId, contactId: event.contactId, clickedAt: null },
        data: { clickedAt: new Date(), status: 'CLICKED' },
      });
      if (updated.count > 0) {
        await prisma.campaign.update({
          where: { id: event.campaignId },
          data: { clickedCount: { increment: updated.count } },
        });
        applied += updated.count;
      }
    } else if (event.type === 'UNSUBSCRIBED') {
      const contact = await prisma.contact.findFirst({
        where: { id: event.contactId, organizationId },
        select: { id: true, email: true, status: true },
      });
      if (!contact || contact.status === 'UNSUBSCRIBED') continue;
      await prisma.contact.update({
        where: { id: contact.id },
        data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() },
      });
      const email = String(event.email || contact.email || '').trim().toLowerCase();
      if (email) {
        await prisma.suppressionList.upsert({
          where: { organizationId_email: { organizationId, email } },
          create: { organizationId, email, reason: 'unsubscribe', source: 'relay' },
          update: { reason: 'unsubscribe' },
        });
      }
      await prisma.campaignRecipient.updateMany({
        where: { campaignId: event.campaignId, contactId: event.contactId },
        data: { status: 'UNSUBSCRIBED' },
      });
      applied += 1;
    }
  }
  return applied;
}

export function mintedRelay(input: {
  organizationId: string;
  campaignId: string;
  contactId: string;
  urls: string[];
}): MintedRelay {
  const tickets: Record<string, string> = {};
  for (const url of input.urls) {
    tickets[url] = encodeRelayClickTicket(input.organizationId, input.campaignId, input.contactId, url);
  }
  return {
    origin: cloudTrackingOrigin(),
    openSig: signRelayOpen(input.organizationId, input.contactId, input.campaignId),
    unsubSig: signRelayUnsubscribe(input.organizationId, input.contactId, input.campaignId),
    tickets,
  };
}
