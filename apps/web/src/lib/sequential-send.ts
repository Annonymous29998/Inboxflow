/** Send this many emails, then pause before the next batch. */
export const EMAIL_SEND_BATCH_SIZE = 20;
export const EMAIL_SEND_BATCH_SIZE_MIN = 1;
export const EMAIL_SEND_BATCH_SIZE_MAX = 500;

export function normalizeBatchSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < EMAIL_SEND_BATCH_SIZE_MIN) return EMAIL_SEND_BATCH_SIZE;
  if (n > EMAIL_SEND_BATCH_SIZE_MAX) return EMAIL_SEND_BATCH_SIZE_MAX;
  return Math.round(n);
}
/** Pause between batches. 0 means the next batch starts immediately. */
export const EMAIL_SEND_BATCH_PAUSE_MS = 0;
/** Gap between each email in a batch. 0 means no gap. */
export const EMAIL_SEND_BETWEEN_MS = 0;
export const EMAIL_SEND_MAX_PER_MINUTE = 600;
export const EMAIL_SEND_MAX_PER_HOUR = 4_800;

function keepNonNegative(raw: unknown, fallback: number, max: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > max) return max;
  return Math.round(n);
}

/** Keep numbers already on the campaign. Fill only the ones that are missing. */
export function recommendedQueuePacing<T extends Record<string, unknown>>(extra?: T) {
  const src = (extra || {}) as T & Record<string, unknown>;
  const minute = keepNonNegative(src.maxPerMinute, EMAIL_SEND_MAX_PER_MINUTE, 600);
  return {
    ...src,
    batchSize: normalizeBatchSize(src.batchSize ?? EMAIL_SEND_BATCH_SIZE),
    batchPauseMs: keepNonNegative(src.batchPauseMs, EMAIL_SEND_BATCH_PAUSE_MS, 600_000),
    betweenEmailMs: keepNonNegative(src.betweenEmailMs, EMAIL_SEND_BETWEEN_MS, 120_000),
    maxPerMinute: minute >= 1 ? minute : EMAIL_SEND_MAX_PER_MINUTE,
    maxPerHour: keepNonNegative(src.maxPerHour, EMAIL_SEND_MAX_PER_HOUR, 50_000) || EMAIL_SEND_MAX_PER_HOUR,
  } as T & {
    batchSize: number;
    batchPauseMs: number;
    betweenEmailMs: number;
    maxPerMinute: number;
    maxPerHour: number;
  };
}

/** Keep the named helper so callers stay stable; delays are exact. */
export function humanDelayMs(baseMs: number): number {
  if (baseMs <= 0) return 0;
  return Math.round(baseMs);
}

export type SendRecipient = {
  id: string;
  contactId: string;
  email: string;
  displayName?: string;
};

export type SendProgressItem = SendRecipient & {
  status: 'pending' | 'sending' | 'sent' | 'failed';
  error?: string;
};

export interface SequentialSendResult {
  sentCount: number;
  failedCount: number;
  failures: string[];
  cancelled: boolean;
}

export interface SequentialSendProgressInfo {
  mode: 'sending' | 'pausing';
  pauseSecondsLeft?: number;
  batchNumber: number;
  totalBatches: number;
  sentInBatch: number;
}

export class EmailSendCancelledError extends Error {
  constructor() {
    super('Sending cancelled');
    this.name = 'EmailSendCancelledError';
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EmailSendCancelledError());
      return;
    }

    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new EmailSendCancelledError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new EmailSendCancelledError();
  }
}

export async function runSequentialEmailSend(options: {
  recipients: SendRecipient[];
  send: (recipient: SendRecipient) => Promise<void>;
  onProgress: (
    items: SendProgressItem[],
    currentEmail: string | null,
    info: SequentialSendProgressInfo,
  ) => void;
  signal?: AbortSignal;
  batchSize?: number;
  batchPauseMs?: number;
  betweenEmailMs?: number;
}): Promise<SequentialSendResult> {
  const {
    recipients,
    send,
    onProgress,
    signal,
    batchSize = EMAIL_SEND_BATCH_SIZE,
    batchPauseMs = EMAIL_SEND_BATCH_PAUSE_MS,
    betweenEmailMs = EMAIL_SEND_BETWEEN_MS,
  } = options;

  const items: SendProgressItem[] = recipients.map((recipient) => ({
    ...recipient,
    status: 'pending',
  }));

  let sentCount = 0;
  let failedCount = 0;
  const failures: string[] = [];
  const totalBatches = Math.max(1, Math.ceil(recipients.length / batchSize));

  const publish = (currentEmail: string | null, info: SequentialSendProgressInfo) => {
    onProgress(
      items.map((item) => ({ ...item })),
      currentEmail,
      info,
    );
  };

  publish(null, {
    mode: 'sending',
    batchNumber: 1,
    totalBatches,
    sentInBatch: 0,
  });

  try {
    for (let index = 0; index < recipients.length; index += 1) {
      assertNotCancelled(signal);

      const batchNumber = Math.floor(index / batchSize) + 1;
      const indexInBatch = index % batchSize;

      if (index > 0 && indexInBatch === 0 && batchPauseMs > 0) {
        let remaining = humanDelayMs(batchPauseMs);
        while (remaining > 0) {
          assertNotCancelled(signal);
          const pauseSecondsLeft = Math.ceil(remaining / 1000);
          publish(null, {
            mode: 'pausing',
            pauseSecondsLeft,
            batchNumber,
            totalBatches,
            sentInBatch: 0,
          });
          const step = Math.min(1000, remaining);
          await sleep(step, signal);
          remaining -= step;
        }
      }

      assertNotCancelled(signal);

      const recipient = recipients[index];
      items[index] = { ...items[index], status: 'sending', error: undefined };
      publish(recipient.email, {
        mode: 'sending',
        batchNumber,
        totalBatches,
        sentInBatch: indexInBatch,
      });

      try {
        await send(recipient);
        assertNotCancelled(signal);
        items[index] = { ...items[index], status: 'sent' };
        sentCount += 1;
      } catch (error) {
        if (error instanceof EmailSendCancelledError) throw error;
        const message = error instanceof Error ? error.message : 'Send failed';
        items[index] = { ...items[index], status: 'failed', error: message };
        failedCount += 1;
        failures.push(`${recipient.email}: ${message}`);
      }

      publish(null, {
        mode: 'sending',
        batchNumber,
        totalBatches,
        sentInBatch: indexInBatch + 1,
      });

      if (index < recipients.length - 1 && betweenEmailMs > 0 && indexInBatch + 1 < batchSize) {
        await sleep(humanDelayMs(betweenEmailMs), signal);
      }
    }

    return { sentCount, failedCount, failures, cancelled: false };
  } catch (error) {
    if (error instanceof EmailSendCancelledError || signal?.aborted) {
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].status === 'sending') {
          items[i] = { ...items[i], status: 'pending', error: undefined };
        }
      }
      publish(null, {
        mode: 'sending',
        batchNumber: Math.max(1, Math.ceil((sentCount + failedCount) / batchSize)),
        totalBatches,
        sentInBatch: (sentCount + failedCount) % batchSize,
      });
      return { sentCount, failedCount, failures, cancelled: true };
    }
    throw error;
  }
}
