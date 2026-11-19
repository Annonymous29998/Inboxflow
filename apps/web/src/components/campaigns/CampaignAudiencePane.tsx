import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

type Row = { email: string; status: string };

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

  const load = useCallback(async () => {
    if (!listId && !campaignId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const people: Row[] = [];
      if (listId) {
        const contacts = await api.get<{ contacts: Array<{ email: string }> }>(
          `/api/contacts?listId=${encodeURIComponent(listId)}&limit=200`,
        );
        for (const c of contacts.contacts || []) {
          people.push({ email: c.email, status: 'QUEUED' });
        }
      }
      if (campaignId) {
        const sent = await api.get<{
          recipients: Array<{ email: string; status: string }>;
        }>(`/api/analytics/campaigns/${campaignId}/recipients?page=1&limit=200&filter=ALL`);
        const byEmail = new Map((sent.recipients || []).map((r) => [r.email, r.status]));
        if (people.length) {
          for (const row of people) {
            const status = byEmail.get(row.email);
            if (status) row.status = status;
          }
        } else {
          for (const r of sent.recipients || []) {
            people.push({ email: r.email, status: r.status });
          }
        }
      }
      setRows(people);
      setPicked((prev) => (prev == null ? people.map((p) => p.email) : prev));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [campaignId, listId]);

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
          {selected.length} of {rows.length} selected
        </span>
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
