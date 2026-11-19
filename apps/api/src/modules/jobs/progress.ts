import type { Job, JobType, JobStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { EventEmitter } from 'node:events';
import { prisma } from '../../config/prisma.js';

export type JobUpdate = Pick<
  Job,
  'id' | 'type' | 'status' | 'total' | 'processed' | 'meta' | 'error' | 'startedAt' | 'finishedAt' | 'campaignId' | 'resourceId'
> & { percent: number };

const bus = new EventEmitter();
bus.setMaxListeners(10_000);

function toUpdate(job: Pick<Job, any>): JobUpdate {
  const total = Math.max(1, Number(job.total) || 0);
  const processed = Math.min(total, Math.max(0, Number(job.processed) || 0));
  const percent = Math.min(100, Math.round((processed / total) * 10000) / 100);
  return {
    id: job.id,
    type: job.type as JobType,
    status: job.status as JobStatus,
    total,
    processed,
    percent,
    meta: job.meta ?? null,
    error: job.error ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    campaignId: job.campaignId ?? null,
    resourceId: job.resourceId ?? null,
  };
}

export function emitJobUpdate(job: Pick<Job, any>) {
  if (!job?.id) return;
  const payload = toUpdate(job);
  bus.emit(`job:${job.id}`, payload);
}

export function subscribeJob(id: string, listener: (u: JobUpdate) => void): () => void {
  bus.on(`job:${id}`, listener);
  return () => bus.off(`job:${id}`, listener);
}

export async function getJobOrThrow(organizationId: string, id: string) {
  const job = await prisma.job.findFirst({ where: { id, organizationId } });
  if (!job) {
    const err = new Error('Job not found') as any;
    err.statusCode = 404;
    throw err;
  }
  return job;
}

export type UpsertJobInput = {
  id: string;
  type: JobType;
  organizationId: string;
  createdById?: string | null;
  campaignId?: string | null;
  resourceId?: string | null;
  total?: number;
  processed?: number;
  status?: JobStatus;
  meta?: Prisma.InputJsonValue;
  error?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

/** Stable Job row so SMTP results can stream live (operator + tenant). */
export async function ensureCampaignSendJob(input: {
  campaignId: string;
  organizationId: string;
  createdById?: string | null;
  total?: number;
}) {
  const id = `send_${input.campaignId}`;
  const existing = await prisma.job.findFirst({
    where: {
      OR: [{ id }, { campaignId: input.campaignId, type: 'CAMPAIGN_SEND' }],
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing && (existing.status === 'RUNNING' || existing.status === 'PAUSED' || existing.status === 'PENDING')) {
    if (input.total && input.total > (existing.total || 0)) {
      return upsertJobProgress({
        id: existing.id,
        type: 'CAMPAIGN_SEND',
        organizationId: existing.organizationId,
        campaignId: input.campaignId,
        status: existing.status === 'PAUSED' ? 'RUNNING' : existing.status,
        total: input.total,
        processed: existing.processed,
        meta: existing.meta as Prisma.InputJsonValue,
      });
    }
    emitJobUpdate(existing);
    return existing;
  }
  return upsertJobProgress({
    id,
    type: 'CAMPAIGN_SEND',
    organizationId: input.organizationId,
    createdById: input.createdById ?? null,
    campaignId: input.campaignId,
    status: 'RUNNING',
    total: input.total ?? 0,
    processed: 0,
    startedAt: new Date(),
    finishedAt: null,
    error: null,
    meta: {
      stage: 'sending',
      sent: 0,
      failed: 0,
      pending: input.total ?? 0,
      lastEmail: null,
    },
  });
}

export async function upsertJobProgress(input: UpsertJobInput) {
  const now = new Date();
  const data: Prisma.JobUpdateInput & Prisma.JobCreateInput = {
    type: input.type,
    status: input.status ?? 'RUNNING',
    organization: { connect: { id: input.organizationId } },
    total: input.total ?? 0,
    processed: input.processed ?? 0,
    meta: input.meta ?? Prisma.JsonNull,
    error: input.error ?? null,
    startedAt: input.startedAt ?? now,
    finishedAt: input.finishedAt ?? null,
    updatedAt: now,
  };
  if (input.createdById) data.createdBy = { connect: { id: input.createdById } };
  if (input.campaignId) data.campaign = { connect: { id: input.campaignId } };
  if (input.resourceId) data.resourceId = input.resourceId;

  const job = await prisma.job.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      type: input.type,
      status: input.status ?? 'RUNNING',
      organizationId: input.organizationId,
      createdById: input.createdById ?? undefined,
      campaignId: input.campaignId ?? undefined,
      resourceId: input.resourceId ?? undefined,
      total: input.total ?? 0,
      processed: input.processed ?? 0,
      meta: input.meta ?? undefined,
      error: input.error ?? undefined,
      startedAt: input.startedAt ?? now,
      finishedAt: input.finishedAt ?? undefined,
      createdAt: now,
      updatedAt: now,
    },
    update: {
      status: input.status,
      total: input.total,
      processed: input.processed,
      meta: input.meta,
      error: input.error,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      updatedAt: now,
    },
  });
  emitJobUpdate(job);
  return job;
}

export { toUpdate };
