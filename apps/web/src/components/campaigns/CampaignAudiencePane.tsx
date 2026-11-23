import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

type Row = { email: string; status: string };

const PAGE_SIZE = 200;

export function CampaignAudiencePane({
  campaignId,
  listId,
}: {
  campaignId?: string;
  listId?: string | null;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    setPage(1);
    setPicked(null);
  }, [listId, campaignId]);

  const load = useCallback(async () => {
    if (!listId && !campaignId) {
      setRows([]);
      setTotal(0);
      setPages(1);
      return;
    }
    setLoading(true);
    try {
      const people: Row[] = [];
      let nextTotal = 0;
      let nextPages = 1;
      if (listId) {
        const contacts = await api.get<{
          contacts: Array<{ email: string }>;
          total: number;
          pages: number;
        }>(
          `/api/contacts?listId=${encodeURIComponent(listId)}&limit=${PAGE_SIZE}&page=${page}`,
        );
        nextTotal = Number(contacts.total) || 0;
        nextPages = Math.max(1, Number(contacts.pages) || 1);
        for (const c of contacts.contacts || []) {
          people.push({ email: c.email, status: 'QUEUED' });
        }
      }
      if (campaignId && !listId) {
        const sent = await api.get<{
          recipients: Array<{ email: string; status: string }>;
          total: number;
          pages: number;
        }>(
          `/api/analytics/campaigns/${campaignId}/recipients?page=${page}&limit=${PAGE_SIZE}&filter=ALL`,
        );
        nextTotal = Number(sent.total) || 0;
        nextPages = Math.max(1, Number(sent.pages) || 1);
        for (const r of sent.recipients || []) {
          people.push({ email: r.email, status: r.status });
        }
      }
      setTotal(nextTotal || people.length);
      setPages(nextPages);
      setRows(people);
    } catch {
      setRows([]);
      setTotal(0);
      setPages(1);
    } finally {
      setLoading(false);
    }
  }, [campaignId, listId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => {
    const set = new Set(picked || rows.map((r) => r.email));
    return rows.filter((r) => set.has(r.email));
  }, [picked, rows]);

  function toggle(email: string, on: boolean) {
    const current = new Set(picked ?? rows.map((r) => r.email));
    if (on) current.add(email);
    else current.delete(email);
    setPicked([...current]);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mailer-toolbar">
        <Button type="button" size="sm" variant="outline" onClick={() => setPicked(rows.map((r) => r.email))}>
          All
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setPicked([])}>
          None
        </Button>
        <span className="count">
          {selected.length} of {rows.length} on this page
          {total > rows.length ? ` · ${total.toLocaleString()} contacts` : ''}
        </span>
        {pages > 1 ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => { setPicked(null); setPage((p) => Math.max(1, p - 1)); }}>
              Back
            </Button>
            <span className="count" style={{ marginLeft: 0 }}>
              {page} / {pages}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page >= pages || loading}
              onClick={() => { setPicked(null); setPage((p) => Math.min(pages, p + 1)); }}
            >
              Next
            </Button>
          </>
        ) : null}
      </div>
      <div className="mailer-pad">
        {loading && !rows.length ? (
          <p className="mailer-hint">Loading recipients…</p>
        ) : !listId && !rows.length ? (
          <p className="mailer-hint">Pick an audience list on Setup.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th />
                <th>Email</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const on = (picked ?? rows.map((r) => r.email)).includes(row.email);
                return (
                  <tr key={row.email}>
                    <td>
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={on}
                        onChange={(e) => toggle(row.email, e.target.checked)}
                      />
                    </td>
                    <td>{row.email}</td>
                    <td>{row.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
