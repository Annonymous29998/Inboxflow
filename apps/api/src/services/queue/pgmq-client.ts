import { prisma } from '../../config/prisma.js';

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

export async function ensurePgmqQueues() {
  if (queuesReady) return;

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

  queuesReady = true;
}

export async function pgmqSend<T extends object>(
  queue: QueueName,
  message: T,
  delaySeconds = 0,
): Promise<bigint> {
  await ensurePgmqQueues();
  const rows = await prisma.$queryRawUnsafe<Array<{ send: bigint }>>(
    `SELECT pgmq.send($1::text, $2::jsonb, $3::integer) AS send`,
    queue,
    JSON.stringify(message),
    delaySeconds,
  );
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
  return prisma.$queryRaw<PgmqMessage<T>[]>`
    SELECT msg_id, read_ct, enqueued_at, vt, message
    FROM pgmq.read(${queue}::text, ${visibilityTimeoutSec}::integer, ${quantity}::integer)
  `;
}

export async function pgmqDelete(queue: QueueName, msgId: bigint): Promise<void> {
  await prisma.$executeRaw`
    SELECT pgmq.delete(${queue}::text, ${msgId}::bigint)
  `;
}

export async function pgmqArchive(queue: QueueName, msgId: bigint): Promise<void> {
  await prisma.$executeRaw`
    SELECT pgmq.archive(${queue}::text, ${msgId}::bigint)
  `;
}

export async function pgmqSetVt(queue: QueueName, msgId: bigint, vtSeconds: number): Promise<void> {
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
