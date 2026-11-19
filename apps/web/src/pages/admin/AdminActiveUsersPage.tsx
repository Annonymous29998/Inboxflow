import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Wifi } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { formatLastSeen, isUserOnline, MONTH_MS, seenWithin, WEEK_MS } from '@/lib/presence';
import { ADMIN_UI_DEMO, DEMO_USERS } from './admin-demo-data';

type Period = 'weekly' | 'monthly';

type ActiveUser = {
  id: string;
  email: string;
  username?: string;
  firstName: string;
  role: string;
  lastLoginAt?: string | null;
  organization?: { name: string } | null;
  pulse?: {
    lastSeenAt?: string | null;
    emailsSent?: number;
  };
};

function nameOf(u: ActiveUser) {
  return u.username || u.firstName || u.email.split('@')[0] || u.email;
}

function lastStamp(u: ActiveUser) {
  return u.pulse?.lastSeenAt || u.lastLoginAt || null;
}

const PAGE_SIZE = 8;

export function AdminActiveUsersPage() {
  const [users, setUsers] = useState<ActiveUser[]>([]);
  const [period, setPeriod] = useState<Period>('weekly');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (ADMIN_UI_DEMO) {
      setUsers(DEMO_USERS);
      return;
    }
    api
      .get<{ users: ActiveUser[] }>('/api/admin/users')
      .then((d) => setUsers((d.users || []).filter((u) => u.role === 'USER')))
      .catch((err) => toast.error('Could not load active users', err instanceof Error ? err.message : undefined));
  }, []);

  const weekly = useMemo(
    () => users.filter((u) => seenWithin(u.pulse?.lastSeenAt, u.lastLoginAt, WEEK_MS)),
    [users],
  );
  const monthly = useMemo(
    () => users.filter((u) => seenWithin(u.pulse?.lastSeenAt, u.lastLoginAt, MONTH_MS)),
    [users],
  );
  const online = useMemo(() => users.filter((u) => isUserOnline(u.pulse?.lastSeenAt)), [users]);
  const list = period === 'weekly' ? weekly : monthly;

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const start = list.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(safePage * PAGE_SIZE, list.length);

  const cards = [
    {
      label: 'Weekly active users',
      value: weekly.length,
      hint: 'Customers seen in the last 7 days',
      icon: CalendarRange,
      ico: 'bg-emerald-50 text-emerald-700',
    },
    {
      label: 'Monthly active users',
      value: monthly.length,
      hint: 'Customers seen in the last 30 days',
      icon: CalendarDays,
      ico: 'bg-sky-50 text-sky-700',
    },
    {
      label: 'Online now',
      value: online.length,
      hint: 'Heartbeat in the last 2 minutes',
      icon: Wifi,
      ico: 'bg-teal-50 text-teal-700',
    },
  ];

  return (
    <div className="if-admin-page">
      <div>
        <h1 className="if-admin-heading if-admin-title font-semibold">Active users</h1>
        <p className="if-admin-lede mt-2 text-sm">Weekly and monthly activity from created users. Operator mailer is not counted.</p>
        {ADMIN_UI_DEMO ? (
          <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-800">
            Layout demo data
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="if-admin-card if-admin-kpi p-4">
            <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${c.ico}`}>
              <c.icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="if-admin-muted text-sm">{c.label}</p>
              <p className="text-2xl font-extrabold text-slate-900">{c.value}</p>
              <p className="if-admin-muted mt-1 text-[11px] leading-snug">{c.hint}</p>
            </div>
          </div>
        ))}
      </div>

      <section className="if-admin-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="if-admin-heading text-xl font-semibold">Registered active users</h2>
            <p className="if-admin-muted mt-1 text-sm">
              {period === 'weekly' ? 'Last 7 days' : 'Last 30 days'} · {list.length} user{list.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="inline-flex rounded-xl border border-slate-300 bg-white p-1">
            {([
              ['weekly', 'Weekly'],
              ['monthly', 'Monthly'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setPeriod(value);
                  setPage(1);
                }}
                className={
                  period === value
                    ? 'rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-bold text-white'
                    : 'rounded-lg px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-100'
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {!list.length ? (
          <div className="mt-6 rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
            No customers were active in this period.
          </div>
        ) : (
          <>
            <ul className="mt-4 space-y-2">
              {slice.map((u) => {
                const seen = lastStamp(u);
                return (
                  <li key={u.id} className="if-admin-surface flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{nameOf(u)}</p>
                      <p className="if-admin-muted truncate text-xs">
                        {u.organization?.name || 'Workspace'} · {u.email}
                      </p>
                    </div>
                    <div className="if-admin-muted shrink-0 text-left text-xs sm:text-right">
                      <p>{u.pulse?.emailsSent ?? 0} emails sent</p>
                      <p>
                        {isUserOnline(u.pulse?.lastSeenAt)
                          ? 'Online now'
                          : seen
                            ? `Last seen ${formatLastSeen(seen)}`
                            : 'No presence yet'}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="if-admin-muted text-xs">
                {start}–{end} of {list.length}
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
          </>
        )}
      </section>
    </div>
  );
}
