import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play, RefreshCw, RotateCcw, Eye, MousePointerClick, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { toast } from '@/stores/toast';
import { cn } from '@/lib/utils';
import { campaignSendService, type SendStatus } from '@/services/campaign-send.service';
import { CampaignRecipientsPanel } from '@/components/campaigns/CampaignRecipientsPanel';

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

function sectionKey(campaignId: string, section: string) {
  return `${campaignId}:${section}`;
}

type CampaignColumnProps = {
  row: QueueRow;
  live: SendStatus | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
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
  onTogglePanel,
  expanded,
  onToggleSection,
  sectionOpen,
  busyId,
  onPause,
  onResume,
  onRetryFailed,
}: CampaignColumnProps) {
  void expanded;
  const status = live?.status || row.status;
  const sent = live?.sentCount ?? row.sent ?? 0;
  const failed = live?.failedCount ?? row.failed ?? 0;
  const bounced = live?.bouncedCount ?? 0;
  const delivered = live?.deliveredCount ?? 0;
  const pending = live?.pendingCount ?? row.pending ?? 0;
  const opened = live?.openedCount ?? row.opened ?? 0;
  const clicked = live?.clickedCount ?? row.clicked ?? 0;
  const total = Math.max(live?.totalRecipients || 0, row.total || 0, sent + failed + pending, 1);
  const finished = sent + failed;
  const percent = Math.min(100, Math.round((finished / total) * 100));
  const sendLogDefaultOpen = status === 'SENDING' || status === 'PAUSED' || finished < 20;
  const engagementCount = live?.engagementActivity?.length ?? 0;
  const canShowRecipientList =
    total > 0 || ['SENDING', 'SENT', 'PAUSED', 'CANCELLED', 'FAILED', 'READY'].includes(status);

  const heartbeat =
    status === 'SENDING'
      ? live?.lastEmail
        ? `Sending now · last ${live.lastEmail}`
        : finished === 0
          ? 'Queued on server — waiting for the first email…'
          : 'Sending…'
      : status === 'PAUSED'
        ? 'Paused — Resume to continue SMTP'
        : status === 'CANCELLED'
          ? 'Cancelled'
          : status === 'SENT'
            ? 'Finished'
            : status === 'FAILED'
              ? 'Stopped by an error'
              : `Status: ${status}`;

  return (
    <div id={`queue-col-${row.id}`} className="tui-box min-w-0 overflow-hidden">
      <button
        type="button"
        onClick={onTogglePanel}
        aria-expanded={panelOpen}
        className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        {panelOpen ? (
          <ChevronDown className="h-4 w-4 flex-none text-primary" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-none text-primary" />
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-accent">
          Live send · {row.name}
        </span>
        <Badge tone={statusTone(status)}>{status}</Badge>
        <Badge tone="neutral">
          {finished}/{total}
        </Badge>
        <span className="hidden shrink-0 text-[10px] uppercase text-muted-foreground sm:inline">
          {panelOpen ? 'Collapse' : 'Expand'}
        </span>
      </button>

      {panelOpen ? (
        <div className="space-y-3 border-t border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-[11px] text-muted-foreground">{live?.subject || row.subject}</span>
              {live?.senderEmail ? (
                <p className="mt-1 text-[11px] text-muted-foreground">From {live.senderEmail}</p>
              ) : null}
            </div>
            <Link to={`/app/campaigns/${row.id}`} className="text-[11px] text-primary hover:underline">
              Open campaign →
            </Link>
          </div>

          <p className="text-lg tracking-widest text-primary" aria-hidden="true">
            {asciiBar(percent)}
          </p>
          <p className="text-xl font-semibold tabular-nums">
            <span className="text-primary">{finished.toLocaleString()}</span>
            <span className="text-muted-foreground"> / </span>
            <span>{total.toLocaleString()}</span>
            <span className="ml-2 text-xs font-normal uppercase text-muted-foreground">
              processed · {percent}%
            </span>
          </p>
          <p className="text-xs text-accent">{heartbeat}</p>

          <div className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
            <div className="border border-border bg-muted/40 px-2 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Accepted</div>
              <div className="mt-1 text-lg tabular-nums text-primary">{sent}</div>
            </div>
            <div className="border border-border bg-muted/40 px-2 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Delivered</div>
              <div className="mt-1 text-lg tabular-nums text-success">{delivered}</div>
            </div>
            <div className="border border-border bg-muted/40 px-2 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Failed</div>
              <div className="mt-1 text-lg tabular-nums text-destructive">{failed}</div>
            </div>
            <div className="border border-border bg-muted/40 px-2 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Bounced</div>
              <div className="mt-1 text-lg tabular-nums text-destructive">{bounced}</div>
            </div>
            <div className="border border-border bg-muted/40 px-2 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Opened</div>
              <div className="mt-1 text-lg tabular-nums text-primary">{opened}</div>
            </div>
            <div className="border border-border bg-muted/40 px-2 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Clicked</div>
              <div className="mt-1 text-lg tabular-nums text-primary">{clicked}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
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
                <RotateCcw className="h-3 w-3" /> Retry failed
              </Button>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="overflow-hidden border border-border">
              <button
                type="button"
                onClick={() => onToggleSection(sectionKey(row.id, 'sendLog'))}
                className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
              >
                {sectionOpen(sectionKey(row.id, 'sendLog'), sendLogDefaultOpen) ? (
                  <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 text-[10px] uppercase tracking-wide text-accent">
                  Send log
                </span>
                <Badge tone="neutral">{live?.activity?.length ?? sent + failed}</Badge>
              </button>
              {sectionOpen(sectionKey(row.id, 'sendLog'), sendLogDefaultOpen) ? (
                <div className="max-h-56 overflow-auto border-t border-border bg-muted/20">
                  {live?.activity?.length ? (
                    <ul className="divide-y divide-border/50 text-[11px]">
                      {live.activity.map((item, i) => (
                        <li key={`${item.status}-${item.email}-${item.at}-${i}`} className="flex gap-2 px-3 py-1.5">
                          <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(item.at)}</span>
                          <span
                            className={cn(
                              'shrink-0 font-semibold',
                              item.status === 'SENT' && 'text-primary',
                              item.status === 'DELIVERED' && 'text-success',
                              (item.status === 'FAILED' || item.status === 'BOUNCED') && 'text-destructive',
                            )}
                          >
                            [{item.status}]
                          </span>
                          <span className="min-w-0 break-all">
                            {item.email}
                            {item.error ? <span className="text-muted-foreground"> — {item.error}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                      {pending > 0 && finished === 0
                        ? 'Waiting for first email to leave SMTP…'
                        : 'No sent/failed lines yet.'}
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <div className="overflow-hidden border border-border">
              <button
                type="button"
                onClick={() => onToggleSection(sectionKey(row.id, 'engagement'))}
                className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
              >
                {sectionOpen(sectionKey(row.id, 'engagement'), engagementCount > 0) ? (
                  <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 text-[10px] uppercase tracking-wide text-accent">
                  Opens & clicks
                </span>
                <Badge tone="neutral">{engagementCount}</Badge>
              </button>
              {sectionOpen(sectionKey(row.id, 'engagement'), engagementCount > 0) ? (
                <div className="max-h-40 overflow-auto border-t border-border bg-muted/20">
                  {engagementCount > 0 ? (
                    <ul className="divide-y divide-border/50 text-[11px]">
                      {live!.engagementActivity!.map((item, i) => (
                        <li key={`eng-${item.status}-${item.email}-${item.at}-${i}`} className="flex gap-2 px-3 py-1.5">
                          <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(item.at)}</span>
                          <span
                            className={cn(
                              'shrink-0 font-semibold',
                              item.status === 'OPENED' && 'text-accent',
                              item.status === 'CLICKED' && 'text-primary',
                            )}
                          >
                            [{item.status}]
                          </span>
                          <span className="min-w-0 break-all">
                            {item.status === 'OPENED' ? <Eye className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                            {item.status === 'CLICKED' ? (
                              <MousePointerClick className="mr-1 inline h-3 w-3" aria-hidden />
                            ) : null}
                            {item.email}
                            {item.url ? <span className="text-muted-foreground"> → {item.url}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                      No verified opens or clicks yet.
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            {canShowRecipientList ? (
              <div className="overflow-hidden border border-border">
                <button
                  type="button"
                  onClick={() => onToggleSection(sectionKey(row.id, 'recipients'))}
                  className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  {sectionOpen(sectionKey(row.id, 'recipients')) ? (
                    <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 text-[10px] uppercase tracking-wide text-accent">
                    All recipients
                  </span>
                  <Badge tone="neutral">{total}</Badge>
                </button>
                {sectionOpen(sectionKey(row.id, 'recipients')) ? (
                  <div className="border-t border-border bg-muted/20 p-3">
                    <CampaignRecipientsPanel
                      campaignId={row.id}
                      campaignName={live?.subject || row.subject || row.name}
                      sentAt={row.sentAt}
                      campaignStatus={status}
                      compact
                      contactsPagination
                      livePoll={status === 'SENDING' || status === 'PAUSED'}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function QueueConsolePage() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [liveById, setLiveById] = useState<Record<string, SendStatus>>({});
  const [panelOpen, setPanelOpen] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [campaignsOpen, setCampaignsOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ campaigns: QueueRow[] }>('/api/campaigns/queue-console');
      setRows(data.campaigns);
      setPanelOpen((prev) => {
        const next = { ...prev };
        for (const c of data.campaigns) {
          if (next[c.id] === undefined) {
            // Only auto-expand while actively sending; finished campaigns start collapsed
            next[c.id] = c.status === 'SENDING' || c.status === 'PAUSED';
          }
        }
        return next;
      });
    } catch (err) {
      toast.error('Could not load queue', err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(id);
  }, [load]);

  // Live SSE for every campaign currently in the queue console (new send = new stream)
  useEffect(() => {
    if (!rows.length) return;
    const cancels: Array<() => void> = [];
    for (const row of rows) {
      const id = row.id;
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
          // Auto-open a newly sending campaign column
          if (status.status === 'SENDING' || status.status === 'PAUSED') {
            setPanelOpen((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
          }
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
  }, [rows.map((r) => r.id).join('|')]);

  function togglePanel(id: string) {
    setPanelOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
  }

  function toggleSection(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }

  function sectionOpen(key: string, defaultOpen = false) {
    return expanded[key] ?? defaultOpen;
  }

  const activeQueueCount = useMemo(
    () => rows.filter((r) => r.status === 'SENDING' || r.status === 'PAUSED').length,
    [rows],
  );

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
            Each campaign gets its own collapsible column. Start another send and a new column appears
            beside (or under) the others — all live, all independent.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {rows.length ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {rows.map((row) => (
            <QueueCampaignColumn
              key={row.id}
              row={row}
              live={liveById[row.id] ?? null}
              panelOpen={panelOpen[row.id] ?? false}
              onTogglePanel={() => togglePanel(row.id)}
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
        <div className="tui-box p-6 text-center text-sm text-muted-foreground">
          No queue campaigns yet. Start a send and a live column will open here.
        </div>
      ) : null}

      <div className="tui-box overflow-hidden">
        <button
          type="button"
          onClick={() => setCampaignsOpen((v) => !v)}
          className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
        >
          {campaignsOpen ? (
            <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 text-[10px] uppercase tracking-wide text-accent">Campaigns</span>
          <Badge tone="neutral">{rows.length}</Badge>
          {activeQueueCount > 0 ? <Badge tone="success">{activeQueueCount} active</Badge> : null}
        </button>
        {campaignsOpen ? (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-180 text-left text-xs">
              <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium tabular-nums">Pending</th>
                  <th className="px-3 py-2 font-medium tabular-nums">Sent</th>
                  <th className="px-3 py-2 font-medium tabular-nums">Opened</th>
                  <th className="px-3 py-2 font-medium tabular-nums">Clicked</th>
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
                      panelOpen[row.id] && 'bg-primary/10',
                    )}
                    onClick={() => {
                      setPanelOpen((prev) => ({ ...prev, [row.id]: true }));
                      try {
                        sessionStorage.setItem('inboxflow:watchingCampaignId', row.id);
                      } catch {
                        /* ignore */
                      }
                      document
                        .getElementById(`queue-col-${row.id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
                    <td className="px-3 py-2 tabular-nums text-primary">{row.opened ?? 0}</td>
                    <td className="px-3 py-2 tabular-nums text-primary">{row.clicked ?? 0}</td>
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
                    <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                      No active or recent queue campaigns.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
