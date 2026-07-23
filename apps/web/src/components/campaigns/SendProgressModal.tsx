import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

export type SendFlowPhase = 'confirm' | 'background' | 'success' | 'error';

interface SendProgressModalProps {
  open: boolean;
  phase: SendFlowPhase;
  sendCount: number;
  sentCount?: number;
  failedCount?: number;
  errorMessage?: string;
  confirmTitle?: string;
  confirmMessage?: string;
  fromLabel?: string;
  batchSize?: number;
  batchPauseSeconds?: number;
  cancelled?: boolean;
  onConfirmSend: () => void;
  onForceSend?: () => void;
  onCancelSend?: () => void;
  onClose: () => void;
}

function asciiBar(percent: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

function formatEta(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function formatSpeed(perMinute: number | null): string {
  if (perMinute == null || !Number.isFinite(perMinute) || perMinute <= 0) return '—';
  if (perMinute < 10) return `${perMinute.toFixed(1)}/min`;
  return `${Math.round(perMinute)}/min`;
}

export function SendProgressModal({
  open,
  phase,
  sendCount,
  sentCount = 0,
  failedCount = 0,
  errorMessage,
  confirmTitle = 'Send campaign?',
  confirmMessage,
  fromLabel,
  batchSize = 10,
  batchPauseSeconds = 5,
  cancelled = false,
  onConfirmSend,
  onForceSend,
  onCancelSend,
  onClose,
}: SendProgressModalProps) {
  const startAtRef = useRef<number | null>(null);
  const endAtRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) {
      startAtRef.current = null;
      endAtRef.current = null;
      return;
    }
    if (phase === 'background') {
      if (startAtRef.current == null) startAtRef.current = Date.now();
      endAtRef.current = null;
      const id = window.setInterval(() => setNow(Date.now()), 500);
      return () => window.clearInterval(id);
    }
    if (phase === 'success' || phase === 'error') {
      if (endAtRef.current == null) endAtRef.current = Date.now();
    }
  }, [open, phase]);

  const stats = useMemo(() => {
    const success = sentCount;
    const failed = failedCount;
    const total = Math.max(sendCount, success + failed, 1);
    const finished = success + failed;
    const remaining = Math.max(0, total - finished);
    const percent = Math.min(100, Math.round((finished / total) * 100));

    const endMs = endAtRef.current ?? now;
    const elapsedMs = startAtRef.current ? Math.max(0, endMs - startAtRef.current) : 0;
    const liveSpeed =
      elapsedMs > 2_000 && finished > 0 ? finished / (elapsedMs / 60_000) : null;
    const etaMs =
      phase === 'background' && liveSpeed && liveSpeed > 0 && remaining > 0
        ? (remaining / liveSpeed) * 60_000
        : remaining === 0
          ? 0
          : null;

    return { success, failed, remaining, total, finished, percent, liveSpeed, etaMs };
  }, [sendCount, sentCount, failedCount, now, phase]);

  if (!open) return null;

  const backdropClose = phase === 'confirm' || phase === 'background';
  const isBackground = phase === 'background';

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 px-4 font-mono">
      {backdropClose ? (
        <button type="button" className="absolute inset-0" onClick={onClose} aria-label="Close" />
      ) : null}

      <div className="relative z-10 w-full max-w-lg overflow-hidden border border-border bg-card text-foreground shadow-2xl">
        {phase === 'confirm' && (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div>
                <h2 className="text-lg font-semibold uppercase tracking-wide text-accent">
                  {confirmTitle}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {confirmMessage ??
                    (sendCount > 0
                      ? `This will email ${formatCount(sendCount)} contact${sendCount === 1 ? '' : 's'}.`
                      : 'This will email all eligible contacts on the selected list, one by one.')}
                </p>
                {fromLabel ? (
                  <p className="mt-2 text-sm">
                    <span className="text-muted-foreground">From:</span>{' '}
                    <span className="text-primary">{fromLabel}</span>
                  </p>
                ) : null}
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Sending runs on the server in the background. You can close this tab or window
                  anytime — emails will keep going. Batches of {batchSize} with a {batchPauseSeconds}s
                  pause between batches.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="border border-border p-2 text-muted-foreground hover:text-primary"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-col-reverse gap-3 px-6 py-5 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={onConfirmSend}>
                Send emails
              </Button>
            </div>
          </>
        )}

        {(phase === 'background' || phase === 'success') && (
          <div className="px-6 py-6">
            <div className="text-center">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {phase === 'success'
                  ? cancelled
                    ? 'Cancelled'
                    : 'Complete'
                  : 'Background send'}
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-wide text-primary">
                {phase === 'success'
                  ? cancelled
                    ? 'Sending stopped'
                    : 'Send finished'
                  : 'Sending in background…'}
              </h2>

              {isBackground ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Safe to close this tab — sending continues on the server.
                </p>
              ) : null}

              <p
                className="mt-5 text-2xl tracking-widest text-primary sm:text-3xl"
                aria-hidden="true"
              >
                {asciiBar(stats.percent)}
              </p>
              <div
                className="sr-only"
                role="progressbar"
                aria-valuenow={stats.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Email send progress"
              >
                {stats.percent}%
              </div>

              <p className="mt-4 text-xl font-semibold tabular-nums sm:text-2xl">
                <span className="text-primary">{formatCount(stats.finished)}</span>
                <span className="text-muted-foreground"> / </span>
                <span>{formatCount(stats.total)}</span>
                <span className="ml-2 text-sm font-normal uppercase tracking-wide text-muted-foreground">
                  Sent
                </span>
              </p>

              {phase === 'background' ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Processing recipients on the server…
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {cancelled
                    ? 'Remaining recipients were left pending'
                    : 'All queued recipients were processed'}
                </p>
              )}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <StatTile label="Success" value={formatCount(stats.success)} tone="ok" />
              <StatTile label="Failed" value={formatCount(stats.failed)} tone="bad" />
              <StatTile label="Remaining" value={formatCount(stats.remaining)} />
              <StatTile
                label="ETA"
                value={phase === 'background' ? formatEta(stats.etaMs) : '0s'}
              />
              <StatTile
                label="Live Speed"
                value={formatSpeed(stats.liveSpeed)}
                className="col-span-2 sm:col-span-1"
              />
            </div>

            <div className="mt-5 flex justify-center gap-3">
              {phase === 'background' && onCancelSend ? (
                <Button type="button" variant="outline" onClick={onCancelSend}>
                  Cancel sending
                </Button>
              ) : null}
              {phase === 'background' ? (
                <Button type="button" variant="outline" onClick={onClose}>
                  Close (keep sending)
                </Button>
              ) : null}
              {phase === 'success' ? (
                <Button type="button" onClick={onClose}>
                  Done
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="px-6 py-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center border border-destructive/40 bg-destructive/10 text-destructive">
              <X className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold">Send failed</h2>
            <p className="mt-2 text-sm text-muted-foreground">{errorMessage || 'Unknown error'}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {onForceSend &&
              /force|high risk|high_risk|deliverability/i.test(errorMessage || '') ? (
                <Button type="button" variant="outline" onClick={onForceSend}>
                  Send anyway
                </Button>
              ) : null}
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'bad';
  className?: string;
}) {
  return (
    <div className={cn('border border-border bg-muted/40 px-2 py-3 text-center', className)}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'ok' && 'text-primary',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </div>
    </div>
  );
}
