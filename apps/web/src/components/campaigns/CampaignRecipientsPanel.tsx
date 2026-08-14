import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, Mail, MousePointerClick } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Card, Input, Select } from '@/components/ui';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

type Recipient = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  openCount: number;
  clickCount: number;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  error: string | null;
};

type Summary = {
  sent: number;
  accepted?: number;
  delivered: number;
  opened: number;
  clicked: number;
  failed?: number;
  bounced?: number;
};

type Props = {
  campaignId: string;
  campaignName?: string;
  sentAt?: string | null;
  /** When SENDING/SENT/PAUSED, recipients auto-refresh from live tracking data */
  campaignStatus?: string;
  /** Compact mode hides the outer title (useful when already inside a page section) */
  compact?: boolean;
  /** Use contacts-style pagination (First / Prev / numbered pages / Next / Last) */
  contactsPagination?: boolean;
  /** Poll while campaign is actively sending (queue console passes false when finished) */
  livePoll?: boolean;
};

function formatTs(iso: string | null) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '';
  }
}

export function CampaignRecipientsPanel({
  campaignId,
  campaignName,
  sentAt,
  campaignStatus,
  compact,
  contactsPagination = false,
  livePoll,
}: Props) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [pageLimit, setPageLimit] = useState<number>(50);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef(false);

  const load = useCallback((opts?: { silent?: boolean }) => {
    if (!campaignId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const silent = opts?.silent ?? false;
    if (silent) setRefreshing(true);
    else setLoading(true);

    const params = new URLSearchParams({
      page: String(page),
      limit: String(pageLimit),
      filter,
    });
    if (search.trim()) params.set('search', search.trim());
    api
      .get<{ recipients: Recipient[]; summary: Summary; total: number; pages: number }>(
        `/api/analytics/campaigns/${campaignId}/recipients?${params}`,
      )
      .then((d) => {
        setRecipients(d.recipients);
        setSummary(d.summary);
        setTotal(d.total);
        setPages(d.pages);
      })
      .catch(console.error)
      .finally(() => {
        inFlightRef.current = false;
        if (silent) setRefreshing(false);
        else setLoading(false);
      });
  }, [campaignId, page, pageLimit, filter, search]);

  useEffect(() => {
    setPage(1);
  }, [pageLimit, filter, search, campaignId]);

  useEffect(() => {
    if (page > pages) setPage(Math.max(1, pages));
  }, [page, pages]);

  useEffect(() => {
    load();
  }, [load]);

  const shouldLivePoll =
    livePoll ??
    (campaignStatus === 'SENDING' || campaignStatus === 'PAUSED');

  useEffect(() => {
    if (!shouldLivePoll) return;
    const id = window.setInterval(() => load({ silent: true }), 8000);
    return () => window.clearInterval(id);
  }, [shouldLivePoll, load]);

  const openPct =
    summary && summary.sent > 0 ? Math.round((summary.opened / summary.sent) * 100) : 0;
  const clickPct =
    summary && summary.sent > 0 ? Math.round((summary.clicked / summary.sent) * 100) : 0;

  /** SMTP accepted (left the mail server) — same “Yes / Delivered” as the older campaign view. */
  const isDelivered = (r: Recipient) =>
    r.delivered ||
    ['DELIVERED', 'OPENED', 'CLICKED', 'SENT'].includes(r.status);

  return (
    <div className="space-y-3">
      {!compact ? (
        <div>
          <h2 className="font-medium">Recipients</h2>
          <p className="text-xs text-ink-muted">
            Opens and clicks from mail clients and browsers, including people
            who unsubscribed. Named bots (curl, scanners) are hidden.
          </p>
        </div>
      ) : null}

      {/* Summary bar — nexlogs style */}
      {summary ? (
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
          <div className="min-w-0">
            {campaignName ? (
              <span className="font-medium text-foreground">{campaignName}</span>
            ) : null}
            <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-muted">HTML</span>
            {sentAt ? (
              <div className="mt-0.5 text-[11px] text-ink-muted">
                {new Date(sentAt).toLocaleString()}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              <span className="font-semibold text-foreground">{summary.accepted ?? summary.delivered}</span>
              <span className="text-ink-muted"> accepted</span>
            </span>
            <span>
              <span className="font-semibold text-success">{summary.delivered}</span>
              <span className="text-ink-muted">/{summary.sent} delivered</span>
            </span>
            <span>
              <span className="font-semibold text-primary">{summary.opened}</span>
              <span className="text-ink-muted"> opened ({openPct}%)</span>
            </span>
            <span>
              <span className="font-semibold text-primary">{summary.clicked}</span>
              <span className="text-ink-muted"> clicked ({clickPct}%)</span>
            </span>
            {(summary.bounced ?? 0) > 0 ? (
              <button
                type="button"
                className="text-destructive hover:underline"
                onClick={() => {
                  setFilter('BOUNCED');
                  setPage(1);
                }}
              >
                <span className="font-semibold">{summary.bounced}</span> bounced — view
              </button>
            ) : null}
            {(summary.failed ?? 0) > 0 ? (
              <button
                type="button"
                className="text-destructive hover:underline"
                onClick={() => {
                  setFilter('FAILED');
                  setPage(1);
                }}
              >
                <span className="font-semibold">{summary.failed}</span> failed — view
              </button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search recipient…"
            className="h-8 max-w-xs text-xs"
          />
          <div className="flex gap-2">
            <Select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
              className="h-8 text-xs"
            >
              <option value="ALL">All statuses</option>
              <option value="SENT">Delivered (no open)</option>
              <option value="DELIVERED">Delivered</option>
              <option value="OPENED">Opened</option>
              <option value="CLICKED">Clicked</option>
              <option value="BOUNCED">Bounced</option>
              <option value="FAILED">Failed</option>
            </Select>
            <Select
              value={String(pageLimit)}
              onChange={(e) => setPageLimit(Number(e.target.value))}
              className="h-8 text-xs"
              aria-label="Rows per page"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} / page</option>
              ))}
            </Select>
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading || refreshing}>
              {shouldLivePoll ? 'Live' : 'Refresh'}
              {refreshing ? '…' : ''}
            </Button>
          </div>
        </div>

        <div className="table-scroll">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-ink-muted">
                <th className="px-4 py-2.5 font-medium">Recipient</th>
                <th className="px-4 py-2.5 font-medium">Delivered</th>
                <th className="px-4 py-2.5 font-medium">Opened</th>
                <th className="px-4 py-2.5 font-medium">Clicked</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && recipients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-ink-muted">
                    Loading recipients…
                  </td>
                </tr>
              ) : recipients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-ink-muted">
                    No recipients found for this campaign yet.
                  </td>
                </tr>
              ) : (
                recipients.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/40 last:border-0 hover:bg-muted/20"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-foreground">{r.email}</div>
                      {r.name ? <div className="text-ink-muted">{r.name}</div> : null}
                      {r.error ? (
                        <div className="mt-0.5 max-w-xs truncate text-[10px] text-destructive">
                          {r.error}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5">
                      {isDelivered(r) ? (
                        <span className="inline-flex items-center gap-1.5 text-success">
                          <Mail className="h-3.5 w-3.5" />
                          Yes
                        </span>
                      ) : r.status === 'FAILED' || r.status === 'BOUNCED' || r.bounced ? (
                        <span className="inline-flex items-center gap-1.5 text-destructive">No</span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.openCount > 0 || r.opened ? (
                        <span className="inline-flex flex-col gap-0.5 text-primary">
                          <span className="inline-flex items-center gap-1.5">
                            <Eye className="h-3.5 w-3.5" />
                            {r.openCount || 1}×
                          </span>
                          {r.openedAt ? (
                            <span className="text-[10px] text-ink-muted">{formatTs(r.openedAt)}</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.clickCount > 0 || r.clicked ? (
                        <span className="inline-flex flex-col gap-0.5 text-primary">
                          <span className="inline-flex items-center gap-1.5">
                            <MousePointerClick className="h-3.5 w-3.5" />
                            {r.clickCount || 1}×
                          </span>
                          {r.clickedAt ? (
                            <span className="text-[10px] text-ink-muted">{formatTs(r.clickedAt)}</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.status === 'FAILED' ? (
                        <span className="font-medium text-destructive" title={r.error || undefined}>
                          Failed
                        </span>
                      ) : r.status === 'BOUNCED' || r.bounced ? (
                        <span className="font-medium text-destructive" title={r.error || undefined}>
                          Bounced
                        </span>
                      ) : r.status === 'UNSUBSCRIBED' ? (
                        <span className="text-primary">Unsubscribed</span>
                      ) : r.clicked || r.clickCount > 0 ? (
                        <span className="text-primary">Clicked</span>
                      ) : r.opened || r.openCount > 0 ? (
                        <span className="text-primary">Opened</span>
                      ) : isDelivered(r) ? (
                        <span className="text-success">Delivered</span>
                      ) : (
                        <span className="text-ink-muted">{r.status}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > 0 ? (
          <div className="border-t border-border px-4 py-3">
            {contactsPagination ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-ink-muted">
                  Showing <span className="font-medium text-foreground">{recipients.length}</span> of{' '}
                  <span className="font-medium text-foreground">{total.toLocaleString()}</span> recipient
                  {total === 1 ? '' : 's'} · Page{' '}
                  <span className="font-medium text-foreground">{Math.min(page, pages)}</span> of{' '}
                  <span className="font-medium text-foreground">{pages}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={page <= 1}>
                    « First
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    ‹ Prev
                  </Button>
                  <div className="hidden items-center gap-1 md:flex">
                    {((): number[] => {
                      if (pages <= 7) {
                        return Array.from({ length: pages }, (_, i) => i + 1);
                      }
                      const start = page <= 4 ? 1 : page >= pages - 3 ? pages - 6 : page - 3;
                      const out: number[] = [];
                      for (let i = 0; i < 7; i++) {
                        const t = start + i;
                        if (t >= 1 && t <= pages) out.push(t);
                      }
                      return out;
                    })().map((target) => (
                      <Button
                        key={target}
                        size="sm"
                        variant={target === page ? 'primary' : 'outline'}
                        onClick={() => setPage(target)}
                      >
                        {target}
                      </Button>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(pages, p + 1))}
                    disabled={page >= pages}
                  >
                    Next ›
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(pages)}
                    disabled={page >= pages}
                  >
                    Last »
                  </Button>
                </div>
              </div>
            ) : pages > 1 ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted">
                  {total} total · Page {page} of {pages}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <span className="text-xs text-ink-muted">
                {total.toLocaleString()} recipient{total === 1 ? '' : 's'}
              </span>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
