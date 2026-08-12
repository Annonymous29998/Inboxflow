import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { toast } from '@/stores/toast';
import { cn } from '@/lib/utils';
import { campaignSendService, type SendStatus } from '@/services/campaign-send.service';

type QueueRow = {
  id: string;
  name: string;
  status: string;
  subject?: string | null;
  pending: number;
  sent: number;
  failed: number;
  total: number;
  updatedAt: string;
};

function statusTone(status: string) {
  if (status === 'SENDING') return 'success' as const;
  if (status === 'PAUSED') return 'warning' as const;
  if (status === 'FAILED' || status === 'CANCELLED') return 'danger' as const;
  if (status === 'SENT') return 'info' as const;
  return undefined;
}

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

export function QueueConsolePage() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [live, setLive] = useState<SendStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ campaigns: QueueRow[] }>('/api/campaigns/queue-console');
      setRows(data.campaigns);
      setSelectedId((current) => {
        if (current && data.campaigns.some((c) => c.id === current)) return current;
        let stored: string | null = null;
        try {
          stored = sessionStorage.getItem('inboxflow:watchingCampaignId');
        } catch {
          stored = null;
        }
        if (stored && data.campaigns.some((c) => c.id === stored)) return stored;
        const sending = data.campaigns.find((c) => c.status === 'SENDING');
        if (sending) return sending.id;
        const paused = data.campaigns.find((c) => c.status === 'PAUSED');
        if (paused) return paused.id;
        return data.campaigns[0]?.id ?? null;
      });
    } catch (err) {
      toast.error('Could not load queue', err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setLive(null);
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const status = await campaignSendService.getSendStatus(selectedId!);
        if (!cancelled) setLive(status);
      } catch {
        /* keep last snapshot */
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedId]);

  const selectedRow = rows.find((r) => r.id === selectedId) || null;
  const progress = useMemo(() => {
    const sent = live?.sentCount ?? selectedRow?.sent ?? 0;
    const failed = live?.failedCount ?? selectedRow?.failed ?? 0;
    const pending = live?.pendingCount ?? selectedRow?.pending ?? 0;
    const total = Math.max(live?.totalRecipients || 0, selectedRow?.total || 0, sent + failed + pending, 1);
    const finished = sent + failed;
    const percent = Math.min(100, Math.round((finished / total) * 100));
    return { sent, failed, pending, total, finished, percent };
  }, [live, selectedRow]);

  const heartbeat =
    live?.status === 'SENDING'
      ? live.lastEmail
        ? `Sending now · last ${live.lastEmail}`
        : progress.finished === 0
          ? 'Queued on server — waiting for the first email to leave SMTP…'
          : 'Sending…'
      : live?.status === 'PAUSED'
        ? 'Paused — nothing is leaving SMTP until you Resume'
        : live?.status === 'CANCELLED'
          ? 'Cancelled — remaining recipients were not sent'
          : live?.status === 'SENT'
            ? 'Finished'
            : live?.status === 'FAILED'
              ? 'Stopped by an error'
              : selectedRow
                ? `Status: ${selectedRow.status}`
                : 'Select a campaign';

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
    <div className="space-y-4 font-mono">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-accent">ops · queue</p>
          <h1 className="page-title text-primary">Queue Console</h1>
          <p className="page-sub max-w-2xl">
            Live send progress stays here even if you leave the campaign editor. Click a row to watch
            each address succeed or fail.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {selectedRow ? (
        <div className="tui-box">
          <div className="tui-box-title">Live send · {selectedRow.name}</div>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone={statusTone(live?.status || selectedRow.status)}>
                    {live?.status || selectedRow.status}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {live?.subject || selectedRow.subject}
                  </span>
                </div>
                {live?.senderEmail ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">From {live.senderEmail}</p>
                ) : null}
              </div>
              <Link
                to={`/app/campaigns/${selectedRow.id}`}
                className="text-[11px] text-primary hover:underline"
              >
                Open campaign →
              </Link>
            </div>

            <p className="text-lg tracking-widest text-primary" aria-hidden="true">
              {asciiBar(progress.percent)}
            </p>
            <p className="text-xl font-semibold tabular-nums">
              <span className="text-primary">{progress.finished.toLocaleString()}</span>
              <span className="text-muted-foreground"> / </span>
              <span>{progress.total.toLocaleString()}</span>
              <span className="ml-2 text-xs font-normal uppercase text-muted-foreground">
                processed · {progress.percent}%
              </span>
            </p>
            <p className="text-xs text-accent">{heartbeat}</p>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="border border-border bg-muted/40 px-2 py-2">
                <div className="text-[10px] uppercase text-muted-foreground">Sent</div>
                <div className="mt-1 text-lg tabular-nums text-primary">{progress.sent}</div>
              </div>
              <div className="border border-border bg-muted/40 px-2 py-2">
                <div className="text-[10px] uppercase text-muted-foreground">Failed</div>
                <div className="mt-1 text-lg tabular-nums text-destructive">{progress.failed}</div>
              </div>
              <div className="border border-border bg-muted/40 px-2 py-2">
                <div className="text-[10px] uppercase text-muted-foreground">Pending</div>
                <div className="mt-1 text-lg tabular-nums text-warning">{progress.pending}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-1">
              {(live?.status || selectedRow.status) === 'SENDING' ? (
                <Button size="sm" variant="outline" disabled={busyId === selectedRow.id} onClick={() => void pause(selectedRow.id)}>
                  <Pause className="h-3 w-3" /> Pause
                </Button>
              ) : null}
              {(live?.status || selectedRow.status) === 'PAUSED' ? (
                <Button size="sm" variant="outline" disabled={busyId === selectedRow.id} onClick={() => void resume(selectedRow.id)}>
                  <Play className="h-3 w-3" /> Resume
                </Button>
              ) : null}
              {progress.failed > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === selectedRow.id}
                  onClick={() => void retryFailed(selectedRow.id)}
                >
                  <RotateCcw className="h-3 w-3" /> Retry failed
                </Button>
              ) : null}
            </div>

            <div className="max-h-72 overflow-auto border border-border bg-muted/20">
              <div className="sticky top-0 border-b border-border bg-card px-3 py-1.5 text-[10px] uppercase tracking-wide text-accent">
                Per-email log (newest first)
              </div>
              {live?.activity?.length ? (
                <ul className="divide-y divide-border/50 text-[11px]">
                  {live.activity.map((item, i) => (
                    <li key={`${item.status}-${item.email}-${item.at}-${i}`} className="flex gap-2 px-3 py-1.5">
                      <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(item.at)}</span>
                      <span
                        className={cn(
                          'shrink-0 font-semibold',
                          item.status === 'SENT' && 'text-primary',
                          item.status === 'FAILED' && 'text-destructive',
                        )}
                      >
                        [{item.status}]
                      </span>
                      <span className="min-w-0 break-all">
                        {item.email}
                        {item.error ? (
                          <span className="text-muted-foreground"> — {item.error}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                  {progress.pending > 0 && progress.finished === 0
                    ? 'No email has left SMTP yet. If this stays empty, the worker is not dequeuing — use Resume or start the send again.'
                    : 'No sent/failed lines yet for this campaign.'}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="tui-box overflow-x-auto">
        <div className="tui-box-title">Campaigns</div>
        <table className="w-full min-w-180 text-left text-xs">
          <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Campaign</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium tabular-nums">Pending</th>
              <th className="px-3 py-2 font-medium tabular-nums">Sent</th>
              <th className="px-3 py-2 font-medium tabular-nums">Failed</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'cursor-pointer border-b border-border/60 hover:bg-muted/30',
                  selectedId === row.id && 'bg-primary/10',
                )}
                onClick={() => {
                  setSelectedId(row.id);
                  try {
                    sessionStorage.setItem('inboxflow:watchingCampaignId', row.id);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                <td className="px-3 py-2">
                  <Link
                    to={`/app/campaigns/${row.id}`}
                    className="text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {row.name}
                  </Link>
                  {row.subject ? (
                    <div className="truncate text-[10px] text-muted-foreground">{row.subject}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                </td>
                <td className="px-3 py-2 tabular-nums text-warning">{row.pending}</td>
                <td className="px-3 py-2 tabular-nums text-primary">{row.sent}</td>
                <td className="px-3 py-2 tabular-nums text-destructive">{row.failed}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                    {row.status === 'SENDING' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => void pause(row.id)}
                      >
                        <Pause className="h-3 w-3" /> Pause
                      </Button>
                    ) : null}
                    {row.status === 'PAUSED' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => void resume(row.id)}
                      >
                        <Play className="h-3 w-3" /> Resume
                      </Button>
                    ) : null}
                    {row.failed > 0 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === row.id}
                        onClick={() => void retryFailed(row.id)}
                        className={cn(row.status === 'SENDING' && 'opacity-90')}
                      >
                        <RotateCcw className="h-3 w-3" /> Retry failed
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && !loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No active or recent queue campaigns.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
