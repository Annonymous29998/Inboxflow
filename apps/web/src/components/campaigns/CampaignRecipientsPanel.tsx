import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, Mail, MousePointerClick } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Card, Input, Select } from '@/components/ui';

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
  delivered: number;
  opened: number;
  clicked: number;
};

type Props = {
  campaignId: string;
  campaignName?: string;
  sentAt?: string | null;
  /** Compact mode hides the outer title (useful when already inside a page section) */
  compact?: boolean;
};

export function CampaignRecipientsPanel({ campaignId, campaignName, sentAt, compact }: Props) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!campaignId) return;
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: '50',
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
      .finally(() => setLoading(false));
  }, [campaignId, page, filter, search]);

  useEffect(() => {
    load();
  }, [load]);

  const openPct =
    summary && summary.sent > 0 ? Math.round((summary.opened / summary.sent) * 100) : 0;
  const clickPct =
    summary && summary.sent > 0 ? Math.round((summary.clicked / summary.sent) * 100) : 0;

  const isDelivered = (r: Recipient) =>
    r.delivered ||
    ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'].includes(r.status);

  return (
    <div className="space-y-3">
      {!compact ? (
        <div>
          <h2 className="font-medium">Recipients</h2>
          <p className="text-xs text-ink-muted">
            Who received, opened, and clicked this campaign
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
              <option value="DELIVERED">Delivered</option>
              <option value="OPENED">Opened</option>
              <option value="CLICKED">Clicked</option>
              <option value="BOUNCED">Bounced</option>
              <option value="FAILED">Failed</option>
            </Select>
            <Button variant="outline" size="sm" onClick={load}>
              Refresh
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
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-ink-muted">
                    Loading recipients…
                  </td>
                </tr>
              ) : recipients.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-ink-muted">
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
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.openCount > 0 || r.opened ? (
                        <span className="inline-flex items-center gap-1.5 text-primary">
                          <Eye className="h-3.5 w-3.5" />
                          {r.openCount || 1}×
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.clickCount > 0 || r.clicked ? (
                        <span className="inline-flex items-center gap-1.5 text-primary">
                          <MousePointerClick className="h-3.5 w-3.5" />
                          {r.clickCount || 1}×
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
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
        ) : null}
      </Card>
    </div>
  );
}
