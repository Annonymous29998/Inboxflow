import { useEffect, useMemo, useState } from 'react';
import { Activity, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { ADMIN_UI_DEMO, DEMO_LOGS } from './admin-demo-data';

type Log = { id: string; action: string; resource: string; createdAt: string };

const PAGE_SIZE = 8;

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'user', label: 'Users' },
  { id: 'login', label: 'Logins' },
  { id: 'campaign', label: 'Campaigns' },
  { id: 'smtp', label: 'SMTP' },
] as const;

function formatAction(action: string) {
  return action.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function actionTone(action: string) {
  if (/SUSPEND|FAIL|ERROR|VIOLAT/i.test(action)) return 'bg-rose-50 text-rose-700';
  if (/LOGIN|CREATED|LICENSE|RENEW|ACTIVE/i.test(action)) return 'bg-emerald-50 text-emerald-700';
  if (/SEND|PAUSE|CAMPAIGN/i.test(action)) return 'bg-amber-50 text-amber-800';
  if (/SMTP/i.test(action)) return 'bg-sky-50 text-sky-700';
  return 'bg-slate-100 text-slate-700';
}

function matchesFilter(action: string, resource: string, filter: string) {
  const blob = `${action} ${resource}`.toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'user') return /user|license|suspend/i.test(blob);
  if (filter === 'login') return /login/i.test(blob);
  if (filter === 'campaign') return /campaign|send|pause/i.test(blob);
  if (filter === 'smtp') return /smtp/i.test(blob);
  return true;
}

export function AdminActivityPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (ADMIN_UI_DEMO) {
      setLogs([...DEMO_LOGS].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
      return;
    }
    api
      .get<{ logs: Log[] }>('/api/admin/audit-logs')
      .then((d) => setLogs(d.logs || []))
      .catch((err) => toast.error('Could not load activity', err instanceof Error ? err.message : undefined));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (!matchesFilter(l.action, l.resource, filter)) return false;
      if (!q) return true;
      return `${l.action} ${l.resource}`.toLowerCase().includes(q);
    });
  }, [logs, search, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const start = filtered.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(safePage * PAGE_SIZE, filtered.length);

  const logins = logs.filter((l) => /LOGIN/i.test(l.action)).length;
  const userEvents = logs.filter((l) => /USER|LICENSE/i.test(l.action)).length;

  return (
    <div className="if-admin-page">
      <div>
        <h1 className="if-admin-heading if-admin-title font-semibold">Activity logs</h1>
        <p className="if-admin-lede mt-2 text-sm">Actions from created users and this operator console.</p>
        {ADMIN_UI_DEMO ? (
          <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-800">
            Layout demo data
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="if-admin-card if-admin-kpi p-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <p className="if-admin-muted text-sm">Total logs</p>
            <p className="text-2xl font-extrabold text-slate-900">{logs.length}</p>
          </div>
        </div>
        <div className="if-admin-card if-admin-kpi p-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <p className="if-admin-muted text-sm">Logins</p>
            <p className="text-2xl font-extrabold text-slate-900">{logins}</p>
          </div>
        </div>
        <div className="if-admin-card if-admin-kpi p-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-700">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <p className="if-admin-muted text-sm">User events</p>
            <p className="text-2xl font-extrabold text-slate-900">{userEvents}</p>
          </div>
        </div>
      </div>

      <section className="if-admin-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search actions or resources…"
              className="if-admin-muted min-w-0 flex-1 bg-transparent py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setFilter(f.id);
                  setPage(1);
                }}
                className={
                  filter === f.id
                    ? 'rounded-full bg-teal-700 px-3 py-1.5 text-xs font-bold text-white'
                    : 'rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100'
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 p-4">
          {slice.map((l) => (
            <article key={l.id} className="if-admin-surface space-y-2 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold capitalize text-slate-900">{formatAction(l.action)}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${actionTone(l.action)}`}>
                      {l.action.replaceAll('_', ' ')}
                    </span>
                  </div>
                  <p className="if-admin-muted text-sm">{l.resource}</p>
                </div>
                <p className="if-admin-muted shrink-0 text-xs sm:text-right">
                  {new Date(l.createdAt).toLocaleString()}
                </p>
              </div>
            </article>
          ))}

          {!filtered.length ? (
            <div className="py-12 text-center">
              <Activity className="mx-auto h-10 w-10 text-slate-400" />
              <p className="mt-3 text-lg font-semibold text-slate-900">No activity yet</p>
              <p className="if-admin-muted mt-1 text-sm">Customer logins, licenses, and campaign events will show here.</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="if-admin-muted text-xs">
                {start}–{end} of {filtered.length}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="if-admin-btn if-admin-btn-ghost min-h-9 px-3"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </button>
                <button
                  type="button"
                  className="if-admin-btn if-admin-btn-ghost min-h-9 px-3"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
