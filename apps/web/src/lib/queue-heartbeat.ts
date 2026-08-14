export function pauseSecondsRemaining(pauseUntil: string | null | undefined, now = Date.now()): number {
  if (!pauseUntil) return 0;
  const end = Date.parse(pauseUntil);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

export function formatQueueHeartbeat(opts: {
  status: string;
  lastEmail?: string | null;
  finished?: number;
  queueStage?: string;
  pauseUntil?: string | null;
  betweenEmailMs?: number | null;
  batchNumber?: number | null;
  queueBatchSize?: number | null;
  now?: number;
}): string {
  const {
    status,
    lastEmail,
    finished = 0,
    queueStage = 'sending',
    pauseUntil,
    betweenEmailMs,
    batchNumber,
    queueBatchSize,
    now = Date.now(),
  } = opts;

  if (status === 'PAUSED') return 'Paused — Resume to continue SMTP';
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'SENT') return 'Finished';
  if (status === 'FAILED') return 'Stopped by an error';
  if (status !== 'SENDING') return `Status: ${status}`;

  if (queueStage === 'batch_pause') {
    const secs = pauseSecondsRemaining(pauseUntil, now);
    const batchLabel =
      batchNumber != null && queueBatchSize != null
        ? `Batch ${batchNumber} done (${queueBatchSize} emails)`
        : 'Batch complete';
    return secs > 0
      ? `Batch pause — ${batchLabel} · resuming in ${secs}s`
      : `Batch pause — ${batchLabel} · resuming…`;
  }

  if (queueStage === 'between_emails' && betweenEmailMs != null && betweenEmailMs > 0) {
    return `Gap ${betweenEmailMs.toLocaleString()}ms before next email`;
  }

  const gap =
    betweenEmailMs != null && betweenEmailMs > 0
      ? ` · ${betweenEmailMs.toLocaleString()}ms between emails`
      : '';
  const batch =
    queueBatchSize != null ? ` · batches of ${queueBatchSize}` : '';

  if (lastEmail) return `Sending · last ${lastEmail}${gap}${batch}`;
  if (finished === 0) return `Queued on server — waiting for the first email…${batch}`;
  return `Sending…${gap}${batch}`;
}
