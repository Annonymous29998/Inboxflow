import { prisma } from '../../config/prisma.js';
import { isSqliteDatabase } from '../../config/db-kind.js';

export type PgmqMessage<T = unknown> = {
  msg_id: bigint;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: T;
};

const QUEUE_NAMES = ['email-send', 'campaign-dispatch', 'bounce-process'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

let queuesReady = false;
let memId = 1n;
type MemRow = {
  queue: QueueName;
  msg_id: bigint;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: unknown;
  archived: boolean;
};
const mem: MemRow[] = [];

function useMemoryQueue() {
  return isSqliteDatabase();
}

export async function ensurePgmqQueues() {
  if (queuesReady) return;
  if (useMemoryQueue()) {
    queuesReady = true;
    return;
  }

  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pgmq`);

  for (const name of QUEUE_NAMES) {
    try {
      await prisma.$executeRawUnsafe(`SELECT pgmq.create($1::text)`, name);
    } catch {
      // queue already exists
    }
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SmtpHourlySent" (
      provider_id TEXT NOT NULL,
      hour_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider_id, hour_key)
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE "SmtpHourlySent" ENABLE ROW LEVEL SECURITY`);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SmtpMinuteSent" (
      provider_id TEXT NOT NULL,
      minute_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider_id, minute_key)
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE "SmtpMinuteSent" ENABLE ROW LEVEL SECURITY`);

  queuesReady = true;
}

export async function pgmqSend<T extends object>(
  queue: QueueName,
  message: T,
  delaySeconds = 0,
): Promise<bigint> {
  await ensurePgmqQueues();
  if (useMemoryQueue()) {
    const id = memId;
    memId += 1n;
    const now = Date.now();
    mem.push({
      queue,
      msg_id: id,
      read_ct: 0,
      enqueued_at: new Date(now),
      vt: new Date(now + Math.max(0, delaySeconds) * 1000),
      message,
      archived: false,
    });
    return id;
  }
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT pgmq.send($1::text, $2::jsonb, $3::integer) AS send`,
    queue,
    JSON.stringify(message),
    delaySeconds,
  )) as Array<{ send: bigint }>;
  return BigInt(rows[0]?.send ?? 0);
}

export async function pgmqSendBatch<T extends object>(
  queue: QueueName,
  messages: T[],
  delaySeconds = 0,
): Promise<void> {
  for (const message of messages) {
    await pgmqSend(queue, message, delaySeconds);
  }
}

export async function pgmqRead<T = unknown>(
  queue: QueueName,
  visibilityTimeoutSec: number,
  quantity: number,
): Promise<PgmqMessage<T>[]> {
  await ensurePgmqQueues();
  if (useMemoryQueue()) {
    const now = Date.now();
    const vtMs = Math.max(1, visibilityTimeoutSec) * 1000;
    const due = mem
      .filter((row) => row.queue === queue && !row.archived && row.vt.getTime() <= now)
      .sort((a, b) => (a.msg_id < b.msg_id ? -1 : 1))
      .slice(0, Math.max(1, quantity));
    for (const row of due) {
      row.read_ct += 1;
      row.vt = new Date(now + vtMs);
    }
    return due.map((row) => ({
      msg_id: row.msg_id,
      read_ct: row.read_ct,
      enqueued_at: row.enqueued_at,
      vt: row.vt,
      message: row.message as T,
    }));
  }
  return prisma.$queryRaw<PgmqMessage<T>[]>`
    SELECT msg_id, read_ct, enqueued_at, vt, message
    FROM pgmq.read(${queue}::text, ${visibilityTimeoutSec}::integer, ${quantity}::integer)
  `;
}

/**
 * Lock one (or a few) due jobs per workspace so a 9k campaign cannot occupy
 * the whole FIFO while other orgs wait. Does not need extra servers.
 */
export async function pgmqReadFairByOrg<T = unknown>(
  queue: QueueName,
  visibilityTimeoutSec: number,
  maxOrgs: number,
  perOrg = 1,
): Promise<PgmqMessage<T>[]> {
  await ensurePgmqQueues();
  if (useMemoryQueue() || queue !== 'email-send') {
    return pgmqRead<T>(queue, visibilityTimeoutSec, Math.max(1, maxOrgs * perOrg));
  }
  const vt = Math.max(1, Math.floor(visibilityTimeoutSec));
  const orgs = Math.max(1, Math.min(32, Math.floor(maxOrgs)));
  const n = Math.max(1, Math.min(5, Math.floor(perOrg)));
  try {
    return await prisma.$queryRawUnsafe<PgmqMessage<T>[]>(
      `
      WITH due AS (
        SELECT msg_id, message
        FROM pgmq."q_email-send"
        WHERE vt <= clock_timestamp()
        ORDER BY msg_id
        FOR UPDATE SKIP LOCKED
      ),
      ranked AS (
        SELECT
          msg_id,
          COALESCE(NULLIF(message->>'organizationId', ''), 'unknown') AS org_id,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(NULLIF(message->>'organizationId', ''), 'unknown')
            ORDER BY msg_id
          ) AS rn
        FROM due
      ),
      org_pick AS (
        SELECT org_id, MIN(msg_id) AS first_id
        FROM ranked
        WHERE rn = 1
        GROUP BY org_id
        ORDER BY first_id
        LIMIT $1
      ),
      picked AS (
        SELECT r.msg_id
        FROM ranked r
        INNER JOIN org_pick o ON o.org_id = r.org_id
        WHERE r.rn <= $2
      )
      UPDATE pgmq."q_email-send" q
      SET
        vt = clock_timestamp() + ($3::text || ' seconds')::interval,
        read_ct = q.read_ct + 1
      FROM picked p
      WHERE q.msg_id = p.msg_id
      RETURNING q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message
      `,
      orgs,
      n,
      String(vt),
    );
  } catch (err) {
    console.error('pgmq fair-by-org read failed; using FIFO read', err);
    return pgmqRead<T>(queue, visibilityTimeoutSec, orgs);
  }
}

export async function pgmqDelete(queue: QueueName, msgId: bigint): Promise<void> {
  if (useMemoryQueue()) {
    const idx = mem.findIndex((row) => row.queue === queue && row.msg_id === msgId);
    if (idx >= 0) mem.splice(idx, 1);
    return;
  }
  await prisma.$executeRaw`
    SELECT pgmq.delete(${queue}::text, ${msgId}::bigint)
  `;
}

export async function pgmqArchive(queue: QueueName, msgId: bigint): Promise<void> {
  if (useMemoryQueue()) {
    const row = mem.find((item) => item.queue === queue && item.msg_id === msgId);
    if (row) row.archived = true;
    return;
  }
  await prisma.$executeRaw`
    SELECT pgmq.archive(${queue}::text, ${msgId}::bigint)
  `;
}

export async function pgmqSetVt(queue: QueueName, msgId: bigint, vtSeconds: number): Promise<void> {
  if (useMemoryQueue()) {
    const row = mem.find((item) => item.queue === queue && item.msg_id === msgId);
    if (row) row.vt = new Date(Date.now() + Math.max(0, vtSeconds) * 1000);
    return;
  }
  await prisma.$executeRaw`
    SELECT pgmq.set_vt(${queue}::text, ${msgId}::bigint, ${vtSeconds}::integer)
  `;
}

export async function pgmqArchiveByCampaign(queue: QueueName, campaignId: string, maxRounds = 50) {
  await ensurePgmqQueues();
  for (let round = 0; round < maxRounds; round += 1) {
    const batch = await pgmqRead<{ campaignId?: string }>(queue, 30, 25);
    if (!batch.length) break;

    let archivedAny = false;
    for (const row of batch) {
      const msg = row.message as { campaignId?: string };
      if (msg.campaignId === campaignId) {
        await pgmqArchive(queue, row.msg_id);
        archivedAny = true;
      } else {
        await pgmqSetVt(queue, row.msg_id, 0);
      }
    }
    if (!archivedAny && batch.length < 25) break;
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
