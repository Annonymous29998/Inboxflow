import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play, RefreshCw, RotateCcw, Eye, MousePointerClick, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { toast } from '@/stores/toast';
import { cn } from '@/lib/utils';
import { formatQueueHeartbeat, pauseSecondsRemaining } from '@/lib/queue-heartbeat';
import { campaignSendService, type SendActivity, type SendStatus } from '@/services/campaign-send.service';
import { SmtpHealthStrip } from '@/components/smtp/SmtpHealthStrip';
import { smtpService, type SmtpProfile } from '@/services/smtp.service';

type QueueRow = {
  id: string;
  name: string;
  status: string;
  subject?: string | null;
  pending: number;
  sent: number;
  failed: number;
  opened?: number;
  clicked?: number;
  total: number;
  updatedAt: string;
  sentAt?: string | null;
};

function asciiBar(percent: number, width = 24): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function formatTime(iso?: string | null) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return '';
  }
}

function sectionKey(campaignId: string, section: string) {
  return `${campaignId}:${section}`;
}

/** Active sends first, then newest by send time (stable; does not reshuffle on open/click recount). */
function sortQueueRows<T extends { status: string; sentAt?: string | null; updatedAt?: string }>(
  rows: T[],
): T[] {
  const rank = (s: string) => {
    if (s === 'SENDING') return 0;
    if (s === 'PAUSED') return 1;
    if (s === 'READY' || s === 'SCHEDULED') return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    const sa = a.sentAt ? Date.parse(a.sentAt) : 0;
    const sb = b.sentAt ? Date.parse(b.sentAt) : 0;
    if (sb !== sa) return sb - sa;
    const ua = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const ub = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return ub - ua;
  });
}

/** Failed/Bounced first (Kestrel-style), then newest. */
function sortProblemsFirst(items: SendActivity[]): SendActivity[] {
  return [...items].sort((a, b) => {
    const rank = (s: string) => (s === 'FAILED' || s === 'BOUNCED' ? 0 : 1);
    const d = rank(a.status) - rank(b.status);
    if (d !== 0) return d;
    return a.at < b.at ? 1 : -1;
  });
}

type CampaignColumnProps = {
  row: QueueRow;
  live: SendStatus | null;
  panelOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  expanded: Record<string, boolean>;
  onToggleSection: (key: string) => void;
  sectionOpen: (key: string, defaultOpen?: boolean) => boolean;
  busyId: string | null;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetryFailed: (id: string) => void;
};

function QueueCampaignColumn({
  row,
  live,
  panelOpen,
  onOpen,
  onClose,
  expanded,
  onToggleSection,
  sectionOpen,
  busyId,
  onPause,
  onResume,
  onRetryFailed,
}: CampaignColumnProps) {
  void expanded;
  const [tick, setTick] = useState(() => Date.now());
  const status = live?.status || row.status;
  const sent = live?.sentCount ?? row.sent ?? 0;
  const failed = live?.failedCount ?? row.failed ?? 0;
  const bounced = live?.bouncedCount ?? 0;
  /** SMTP accepted — same figure as API sentCount (not rare ESP “delivered” webhooks). */
  const delivered = sent;
  const pending = live?.pendingCount ?? row.pending ?? 0;
  const opened = live?.openedCount ?? row.opened ?? 0;
  const clicked = live?.clickedCount ?? row.clicked ?? 0;
  const total = Math.max(live?.totalRecipients || 0, row.total || 0, sent + failed + pending, 1);
  const finished = sent + failed;
  const percent = Math.min(100, Math.round((finished / total) * 100));
  const problems = failed + bounced;
  const sendLogDefaultOpen = status === 'SENDING' || status === 'PAUSED' || finished < 20;
  const problemsDefaultOpen = problems > 0;
  const engagementCount = live?.engagementActivity?.length ?? 0;

  const activitySorted = useMemo(
    () => (live?.activity?.length ? sortProblemsFirst(live.activity) : []),
    [live?.activity],
  );
  const problemLines = useMemo(() => {
    const fromActivity = activitySorted.filter(
      (a) => a.status === 'FAILED' || a.status === 'BOUNCED',
    );
    if (fromActivity.length) return fromActivity;
    const fails = (live?.recentFailures || []).map((f) => ({
      email: f.email,
      status: 'FAILED' as const,
      error: f.error,
      at: '',
    }));
    const bounces = (live?.recentBounces || []).map((f) => ({
      email: f.email,
      status: 'BOUNCED' as const,
      error: f.error,
      at: '',
    }));
    return [...fails, ...bounces];
  }, [activitySorted, live?.recentFailures, live?.recentBounces]);

  const isBatchPause = status === 'SENDING' && live?.queueStage === 'batch_pause';
  useEffect(() => {
    if (!isBatchPause) return;
    const id = window.setInterval(() => setTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isBatchPause, live?.pauseUntil]);

  const heartbeat = formatQueueHeartbeat({
    status,
    lastEmail: live?.lastEmail,
    finished,
    queueStage: live?.queueStage,
    pauseUntil: live?.pauseUntil,
    betweenEmailMs: live?.betweenEmailMs,
    batchNumber: live?.batchNumber,
    queueBatchSize: live?.queueBatchSize,
    now: tick,
  });

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [panelOpen, onClose]);

  const detail = (
          <div className="mailer-pad space-y-3">
          <p className="mailer-hint" style={{ marginTop: 0 }}>
            {live?.senderEmail ? `From ${live.senderEmail} · ` : ''}
            {heartbeat}
          </p>

          <p className="break-all text-base tracking-widest text-primary sm:text-lg" aria-hidden="true">
            {asciiBar(percent, 16)}
          </p>
          <p className="text-lg font-semibold tabular-nums sm:text-xl">
            <span className="text-primary">{finished.toLocaleString()}</span>
            <span className="text-muted-foreground"> / </span>
            <span>{total.toLocaleString()}</span>
            <span className="ml-2 text-[10px] font-normal uppercase text-muted-foreground sm:text-xs">
              processed · {percent}%
            </span>
          </p>
          {isBatchPause ? (
            <div className="border border-warning/40 bg-warning/10 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-warning">Waiting before next batch</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-warning">
                {pauseSecondsRemaining(live?.pauseUntil, tick)}s
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {live?.batchNumber != null && live?.queueBatchSize != null
                  ? `Batch ${live.batchNumber} done (${live.queueBatchSize} emails). Sending resumes automatically.`
                  : 'Sending resumes automatically after this pause.'}
              </p>
            </div>
          ) : null}

          <div className="mailer-statgrid">
            {[
              ['Failed', failed, 'mailer-err'],
              ['Bounced', bounced, 'mailer-err'],
              ['Sent', sent, ''],
              ['SMTP OK', delivered, ''],
              ['Opened', opened, ''],
              ['Clicked', clicked, ''],
            ].map(([label, value, tone]) => (
              <div key={String(label)} className="mailer-stat">
                <b className={cn(tone === 'mailer-err' && 'text-destructive')}>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <button
              type="button"
              className="mailer-hint w-full text-left"
              style={{ marginTop: 0 }}
              onClick={() => onToggleSection(sectionKey(row.id, 'problems'))}
            >
              {sectionOpen(sectionKey(row.id, 'problems'), problemsDefaultOpen) ? '▾' : '▸'} Failed &amp; bounced · {problems}
            </button>
            {sectionOpen(sectionKey(row.id, 'problems'), problemsDefaultOpen) ? (
              <div className="mailer-logs max-h-40 border border-[var(--mailer-stroke)] sm:max-h-56">
                {problemLines.length ? (
                  problemLines.map((item, i) => (
                    <div key={`prob-${item.status}-${item.email}-${i}`} className="mailer-err break-all">
                      {item.at ? `[${formatTime(item.at)}] ` : ''}[{item.status}] {item.email}
                      {item.error ? ` — ${item.error}` : ''}
                    </div>
                  ))
                ) : (
                  <p className="mailer-hint" style={{ marginTop: 0 }}>
                    No SMTP rejects or ESP bounces yet.
                  </p>
                )}
              </div>
            ) : null}

            <button
              type="button"
              className="mailer-hint w-full text-left"
              style={{ marginTop: 0 }}
              onClick={() => onToggleSection(sectionKey(row.id, 'sendLog'))}
            >
              {sectionOpen(sectionKey(row.id, 'sendLog'), sendLogDefaultOpen) ? '▾' : '▸'} Send log ·{' '}
              {live?.activity?.length ?? sent + failed}
            </button>
            {sectionOpen(sectionKey(row.id, 'sendLog'), sendLogDefaultOpen) ? (
              <div className="mailer-logs max-h-[min(50vh,360px)] border border-[var(--mailer-stroke)] sm:max-h-[min(70vh,520px)]">
                {activitySorted.length ? (
                  activitySorted.map((item, i) => (
                    <div
                      key={`${item.status}-${item.email}-${item.at}-${i}`}
                      className={cn(
                        'break-all',
                        item.status === 'SENT' && 'mailer-ok',
                        item.status === 'DELIVERED' && 'mailer-ok',
                        (item.status === 'FAILED' || item.status === 'BOUNCED') && 'mailer-err',
                      )}
                    >
                      [{formatTime(item.at)}] [{item.status}] {item.email}
                      {item.error ? ` — ${item.error}` : ''}
                    </div>
                  ))
                ) : (
                  <p className="mailer-hint" style={{ marginTop: 0 }}>
                    {pending > 0 && finished === 0
                      ? 'Waiting for first email to leave SMTP…'
                      : 'No sent/failed lines yet.'}
                  </p>
                )}
              </div>
            ) : null}

            <button
              type="button"
              className="mailer-hint w-full text-left"
              style={{ marginTop: 0 }}
              onClick={() => onToggleSection(sectionKey(row.id, 'engagement'))}
            >
              {sectionOpen(sectionKey(row.id, 'engagement'), engagementCount > 0) ? '▾' : '▸'} Opens &amp; clicks ·{' '}
              {engagementCount}
            </button>
            {sectionOpen(sectionKey(row.id, 'engagement'), engagementCount > 0) ? (
              <div className="mailer-logs max-h-40 border border-[var(--mailer-stroke)] sm:max-h-56">
                {engagementCount > 0 ? (
                  live!.engagementActivity!.map((item, i) => (
                    <div
                      key={`eng-${item.status}-${item.email}-${item.at}-${i}`}
                      className={cn(
                        'break-all',
                        item.status === 'OPENED' && 'mailer-warn',
                        item.status === 'CLICKED' && 'mailer-ok',
                      )}
                    >
                      {item.status === 'OPENED' ? <Eye className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                      {item.status === 'CLICKED' ? (
                        <MousePointerClick className="mr-1 inline h-3 w-3" aria-hidden />
                      ) : null}
                      [{formatTime(item.at)}] [{item.status}] {item.email}
                      {(item.times ?? 1) > 1 ? ` ${item.times}×` : ''}
                      {item.url ? ` → ${item.url}` : ''}
                    </div>
                  ))
                ) : (
                  <p className="mailer-hint" style={{ marginTop: 0 }}>
                    No verified opens or clicks yet.
                  </p>
                )}
              </div>
            ) : null}
          </div>
          </div>
  );

  return (
    <div id={`queue-col-${row.id}`} className="min-w-0">
      <div className="camp-row">
        <button type="button" className="camp-row-main text-left" onClick={onOpen}>
          <strong>{row.name}</strong>
          <div className="meta">
            {live?.subject || row.subject || 'No subject'}
            {` · ${finished}/${total} · ${isBatchPause ? 'BATCH PAUSE' : status}`}
          </div>
        </button>
        <div className="camp-row-actions">
          {status === 'SENDING' ? (
            <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => onPause(row.id)}>
              <Pause className="h-3 w-3" /> Pause
            </Button>
          ) : null}
          {status === 'PAUSED' ? (
            <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => onResume(row.id)}>
              <Play className="h-3 w-3" /> Resume
            </Button>
          ) : null}
          {failed > 0 ? (
            <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => onRetryFailed(row.id)}>
              <RotateCcw className="h-3 w-3" /> Retry
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onOpen}>
            Details
          </Button>
        </div>
      </div>

      {panelOpen
        ? createPortal(
            <div className="mailer-root fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-4">
              <button
                type="button"
                className="absolute inset-0 bg-black/75"
                aria-label="Close campaign details"
                onClick={onClose}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={`queue-modal-title-${row.id}`}
                className="mailer-panel relative z-10 flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden sm:max-h-[88dvh]"
              >
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--mailer-stroke)] px-4 py-3">
                  <div className="min-w-0">
                    <p className="mailer-hint" style={{ marginTop: 0 }}>
                      queue · campaign
                    </p>
                    <h2 id={`queue-modal-title-${row.id}`} className="truncate text-base font-semibold text-primary">
                      {row.name}
                    </h2>
                    <p className="mt-1 truncate text-xs text-accent">{live?.subject || row.subject || 'No subject'}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {status === 'SENDING' ? (
                      <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => onPause(row.id)}>
                        <Pause className="h-3 w-3" /> Pause
                      </Button>
                    ) : null}
                    {status === 'PAUSED' ? (
                      <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => onResume(row.id)}>
                        <Play className="h-3 w-3" /> Resume
                      </Button>
                    ) : null}
                    <Link
                      to={`/app/campaigns/${row.id}?tab=logs`}
                      className="inline-flex h-8 items-center border border-border px-2.5 text-[11px] uppercase tracking-wide text-primary hover:bg-muted/40"
                    >
                      Editor
                    </Link>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center border border-border text-muted-foreground hover:text-primary"
                      onClick={onClose}
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function QueueConsolePage() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [liveById, setLiveById] = useState<Record<string, SendStatus>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [smtpProfiles, setSmtpProfiles] = useState<SmtpProfile[]>([]);

  const loadSmtp = useCallback(async () => {
    try {
      const list = await smtpService.list();
      setSmtpProfiles(list);
    } catch {
      /* non-blocking */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ campaigns: QueueRow[] }>('/api/campaigns/queue-console');
      setRows(sortQueueRows(Array.isArray(data.campaigns) ? data.campaigns : []));
    } catch (err) {
      toast.error('Could not load queue', err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSmtp();
    const id = window.setInterval(() => void load(), 8000);
    const smtpId = window.setInterval(() => void loadSmtp(), 20_000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(smtpId);
    };
  }, [load, loadSmtp]);

  // Live SSE only for campaigns that are actually sending/paused.
  // Opening a stream per finished campaign saturates Chrome's 6 connections
  // per host (HTTP/1.1), so Pause/Resume POST never leaves the browser.
  const liveStreamKey = rows
    .filter((r) => r.status === 'SENDING' || r.status === 'PAUSED')
    .map((r) => r.id)
    .sort()
    .join('|');

  useEffect(() => {
    if (!liveStreamKey) return;
    const ids = liveStreamKey.split('|').filter(Boolean);
    const cancels: Array<() => void> = [];
    for (const id of ids) {
      const sub = campaignSendService.streamSendStatus(id, {
        onUpdate: (status) => {
          setLiveById((prev) => ({ ...prev, [id]: status }));
          setRows((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    status: status.status,
                    sent: status.sentCount,
                    failed: status.failedCount,
                    pending: status.pendingCount,
                    opened: status.openedCount ?? r.opened ?? 0,
                    clicked: status.clickedCount ?? r.clicked ?? 0,
                    total: Math.max(
                      r.total,
                      status.totalRecipients,
                      status.sentCount + status.failedCount + status.pendingCount,
                    ),
                  }
                : r,
            ),
          );
          /* Keep the list compact — details open in a modal on click. */
        },
        onError: () => {
          void campaignSendService.getSendStatus(id).then((status) => {
            setLiveById((prev) => ({ ...prev, [id]: status }));
          });
        },
      });
      cancels.push(() => sub.cancel());
    }
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [liveStreamKey]);

  function openCampaign(id: string) {
    setOpenId(id);
    void campaignSendService.getSendStatus(id).then((status) => {
      setLiveById((p) => ({ ...p, [id]: status }));
    });
  }

  function toggleSection(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }

  function sectionOpen(key: string, defaultOpen = false) {
    return expanded[key] ?? defaultOpen;
  }

  const sendingCount = useMemo(() => rows.filter((r) => r.status === 'SENDING').length, [rows]);
  const pausedCount = useMemo(() => rows.filter((r) => r.status === 'PAUSED').length, [rows]);

  async function pause(id: string) {
    setBusyId(id);
    try {
      await api.post(`/api/campaigns/${id}/pause`);
      toast.success('Campaign paused');
      await load();
    } catch (err) {
      toast.error('Pause failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function resume(id: string) {
    setBusyId(id);
    try {
      await api.post(`/api/campaigns/${id}/resume`);
      toast.success('Campaign resumed');
      await load();
    } catch (err) {
      toast.error('Resume failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function retryFailed(id: string) {
    setBusyId(id);
    try {
      const data = await api.post<{ retried: number }>(`/api/campaigns/${id}/retry-failed`);
      toast.success('Retrying failed', `${data.retried} recipient(s) re-queued`);
      await load();
    } catch (err) {
      toast.error('Retry failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mailer-root queue-root space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mailer-hint" style={{ marginTop: 0 }}>
            ops · queue
          </p>
          <h1 className="page-title text-primary">Queue</h1>
          <p className="page-sub">
            {sendingCount} sending · {pausedCount} paused · {rows.length} campaign{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void load(); void loadSmtp(); }} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <SmtpHealthStrip providers={smtpProfiles} />

      {rows.length ? (
        <div className="space-y-3">
          {rows.map((row) => (
            <QueueCampaignColumn
              key={row.id}
              row={row}
              live={liveById[row.id] ?? null}
              panelOpen={openId === row.id}
              onOpen={() => openCampaign(row.id)}
              onClose={() => setOpenId(null)}
              expanded={expanded}
              onToggleSection={toggleSection}
              sectionOpen={sectionOpen}
              busyId={busyId}
              onPause={(id) => void pause(id)}
              onResume={(id) => void resume(id)}
              onRetryFailed={(id) => void retryFailed(id)}
            />
          ))}
        </div>
      ) : !loading ? (
        <div className="mailer-panel">
          <div className="mailer-pad">
            <p className="mailer-hint" style={{ marginTop: 0 }}>
              No queue campaigns yet. Start a send and a live row will open here.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
