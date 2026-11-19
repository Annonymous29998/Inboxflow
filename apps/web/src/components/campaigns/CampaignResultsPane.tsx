import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { toast } from '@/stores/toast';
import { confirmDialog } from '@/stores/confirm';

type Row = {
  email: string;
  status: string;
  openCount: number;
  clickCount: number;
};

type Summary = {
  sent: number;
  opened: number;
  clicked: number;
  failed?: number;
  bounced?: number;
};

export function CampaignResultsPane({
  campaignId,
  listId,
  campaignStatus,
  sentCount = 0,
  openedCount = 0,
  clickedCount = 0,
  failedCount = 0,
}: {
  campaignId?: string;
  listId?: string | null;
  campaignStatus?: string;
  sentCount?: number;
  openedCount?: number;
  clickedCount?: number;
  failedCount?: number;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!campaignId) return;
    if (!silent) setLoading(true);
    try {
      const data = await api.get<{
        recipients: Array<{
          email: string;
          status: string;
          opened?: boolean;
          clicked?: boolean;
          openCount?: number;
          clickCount?: number;
        }>;
        summary: Summary;
        total: number;
      }>(`/api/analytics/campaigns/${campaignId}/recipients?page=1&limit=200&filter=ALL`);
      setSummary(data.summary);
      if (data.recipients?.length) {
        setRows(
          data.recipients.map((r) => ({
            email: r.email,
            status: r.status,
            openCount: r.openCount ?? (r.opened ? 1 : 0),
            clickCount: r.clickCount ?? (r.clicked ? 1 : 0),
          })),
        );
        return;
      }
      if (listId) {
        const contacts = await api.get<{ contacts: Array<{ email: string }> }>(
          `/api/contacts?listId=${encodeURIComponent(listId)}&limit=200`,
        );
        setRows(
          (contacts.contacts || []).map((c) => ({
            email: c.email,
            status: 'QUEUED',
            openCount: 0,
            clickCount: 0,
          })),
        );
      } else {
        setRows([]);
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [campaignId, listId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (campaignStatus !== 'SENDING' && campaignStatus !== 'PAUSED') return;
    const id = window.setInterval(() => void load(true), 1500);
    return () => window.clearInterval(id);
  }, [campaignStatus, load]);

  const sent = summary?.sent ?? sentCount;
  const opened = summary?.opened ?? openedCount;
  const clicked = summary?.clicked ?? clickedCount;
  const failed = summary?.failed ?? failedCount;
  const bounced = summary?.bounced ?? rows.filter((r) => r.status === 'BOUNCED').length;

  async function removeBounces() {
    if (!campaignId) return;
    const ok = await confirmDialog({
      title: 'Remove bounces from the list?',
      description: 'Those addresses leave this audience. Open/click history on this campaign stays.',
      tone: 'warning',
      confirmText: 'Remove bounces',
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const d = await api.post<{ removed: number; bounced: number }>(`/api/campaigns/${campaignId}/remove-bounces`);
      toast.success(`Removed ${d.removed || d.bounced || 0} bounced addresses from the list`);
      void load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove bounces');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="mailer-pad">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="mailer-hint" style={{ marginTop: 0 }}>
          Opens and clicks for <strong>this campaign only</strong> — not the campaign list.
        </p>
        <Button type="button" size="sm" variant="outline" disabled={!campaignId || removing || bounced < 1} onClick={() => void removeBounces()}>
          {removing ? 'Removing…' : `Remove bounces from list${bounced ? ` (${bounced})` : ''}`}
        </Button>
      </div>
      <div className="mailer-statgrid">
        {[
          ['Sent', sent],
          ['Opened', opened],
          ['Clicked', clicked],
          ['Failed', failed],
          ['Bounced', bounced],
        ].map(([label, value]) => (
          <div key={String(label)} className="mailer-stat">
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="mt-4">
        {loading && !rows.length ? (
          <p className="mailer-hint">Loading this campaign…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Opened</th>
                <th>Clicked</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => (
                  <tr key={row.email}>
                    <td>{row.email}</td>
                    <td>{row.status}</td>
                    <td>{row.openCount ? `${row.openCount}×` : '—'}</td>
                    <td>{row.clickCount ? `${row.clickCount}×` : '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4}>
                    Pick an audience on Setup, then SEND. This tab stays on this campaign only.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
