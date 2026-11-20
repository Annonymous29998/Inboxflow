import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  HeartPulse,
  LayoutDashboard,
  Mail,
  RefreshCw,
  Search,
  Server,
  Users,
  Wifi,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import { toast } from '@/stores/toast';
import { useWhenVisiblePoll } from '@/lib/admin-poll';
import { ADMIN_UI_DEMO, demoOverview, hydrateDemoUsers } from './admin-demo-data';
import { buildInsights, type InsightUser, usernameOf } from './admin-insights';

type Overview = {
  health: { status: string; database: string };
  stats: {
    users: number;
    workspaces: number;
    sending: number;
    online: number;
    sent: number;
    emailsSent: number;
    emailsFailed: number;
  };
  recentUsers: Array<{
    id: string;
    email: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
    status: string;
    lastLoginAt?: string | null;
    organization?: { name: string } | null;
    pulse?: { lastSeenAt?: string | null };
  }>;
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    sentCount: number;
    openedCount: number;
    organization?: { name: string } | null;
    user?: { username?: string; name: string; email: string } | null;
    updatedAt: string;
  }>;
};

const QUICK = [
  { to: '/admin/users', title: 'Users & workspaces', description: 'Issue a username and license key.', icon: Users },
  { to: '/admin/health', title: 'Health', description: 'Attention, send volume, and where data lives.', icon: HeartPulse },
  { to: '/admin/activity', title: 'Activity logs', description: 'Audit who did what across workspaces.', icon: Activity },
  { to: '/app/campaigns', title: 'Mailer', description: 'Leave admin and open the campaign workspace.', icon: Mail },
  { to: '/app/smtp', title: 'SMTP Manager', description: 'Your operator SMTP profiles.', icon: Server },
];

type TenantUser = InsightUser & {
  role?: string;
  firstName?: string;
  lastName?: string;
  pulse?: InsightUser['pulse'] & {
    sending?: number;
    campaignsSent?: number;
    recentCampaigns?: Overview['recentCampaigns'];
  };
};

function campaignsFromTenants(users: TenantUser[]): Overview['recentCampaigns'] {
  return users
    .flatMap((u) =>
      (u.pulse?.recentCampaigns || []).map((c) => {
        const username = c.user?.username || usernameOf(u);
        return {
          id: c.id || `${u.id}-${c.updatedAt}`,
          name: c.name || 'Campaign',
          status: c.status || 'DRAFT',
          sentCount: c.sentCount || 0,
          openedCount: c.openedCount ?? 0,
          updatedAt: c.updatedAt,
          user: { username, name: username, email: u.email },
          organization: c.organization || u.organization || null,
        };
      }),
    )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 20);
}

function labelCampaigns(
  campaigns: Overview['recentCampaigns'],
  users: TenantUser[],
): Overview['recentCampaigns'] {
  return campaigns.flatMap((c) => {
    const match = users.find(
      (u) =>
        (c.user?.email && u.email === c.user.email) ||
        (c.user?.username && usernameOf(u) === c.user.username) ||
        (c.user?.name && usernameOf(u) === c.user.name) ||
        (c.organization?.name && u.organization?.name === c.organization.name),
    );
    const username = c.user?.username || c.user?.name || (match ? usernameOf(match) : '');
    if (!username) return [];
    if (!match && !c.user?.username && !c.user?.name) return [];
    return [
      {
        ...c,
        user: {
          username,
          name: username,
          email: match?.email || c.user?.email || '',
        },
      },
    ];
  });
}

async function loadOverviewFallback(): Promise<{ overview: Overview; tenants: TenantUser[] }> {
  const [usersRes, healthRes] = await Promise.all([
    api.get<{ users: TenantUser[] }>('/api/admin/users'),
    api.get<{ status: string; database: string }>('/api/admin/health'),
  ]);
  const users = (usersRes.users || []).filter((u) => u.role === 'USER');
  const workspaces = new Set(users.map((u) => u.organization?.name || u.email)).size;
  const pulse = users.reduce(
    (acc, u) => {
      acc.sending += u.pulse?.sending || 0;
      acc.sent += u.pulse?.campaignsSent || 0;
      acc.emailsSent += u.pulse?.emailsSent || 0;
      acc.emailsFailed += u.pulse?.emailsFailed || 0;
      return acc;
    },
    { sending: 0, sent: 0, emailsSent: 0, emailsFailed: 0 },
  );
  return {
    tenants: users,
    overview: {
      health: { status: healthRes.status || 'ok', database: healthRes.database || 'up' },
      stats: {
        users: users.length,
        workspaces,
        sending: pulse.sending,
        online: 0,
        sent: pulse.sent,
        emailsSent: pulse.emailsSent,
        emailsFailed: pulse.emailsFailed,
      },
      recentUsers: users.slice(0, 8),
      recentCampaigns: campaignsFromTenants(users),
    },
  };
}

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<TenantUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  async function load(opts?: { quiet?: boolean }) {
    if (!opts?.quiet) setBusy(true);
    const started = Date.now();
    try {
      if (ADMIN_UI_DEMO) {
        const demoTenants = hydrateDemoUsers() as TenantUser[];
        setTenants(demoTenants);
        setData(demoOverview());
      } else {
        const usersRes = await api.get<{ users: TenantUser[] }>('/api/admin/users').catch(() => ({ users: [] as TenantUser[] }));
        const nextTenants = (usersRes.users || []).filter((u) => u.role === 'USER');
        setTenants(nextTenants);
        const pulseCampaigns = campaignsFromTenants(nextTenants);
        const recents = await api
          .get<{ campaigns: Overview['recentCampaigns'] }>('/api/admin/recent-campaigns')
          .catch(() => ({ campaigns: [] as Overview['recentCampaigns'] }));
        const labeledApi = labelCampaigns(recents.campaigns || [], nextTenants);
        const byId = new Map<string, Overview['recentCampaigns'][number]>();
        for (const row of [...labeledApi, ...pulseCampaigns]) {
          if (row.user?.username || row.user?.name) byId.set(row.id, row);
        }
        const recentCampaigns = [...byId.values()]
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, 20);
        const insights = buildInsights(nextTenants);
        try {
          const d = await api.get<Overview & { scope?: string }>('/api/admin/overview');
          setData({
            ...d,
            stats: { ...d.stats, online: insights.online.length },
            recentUsers: nextTenants.slice(0, 8),
            recentCampaigns,
          });
        } catch {
          const fallback = await loadOverviewFallback();
          setTenants(fallback.tenants);
          setData({
            ...fallback.overview,
            stats: { ...fallback.overview.stats, online: buildInsights(fallback.tenants).online.length },
            recentCampaigns,
          });
        }
      }
    } catch (err) {
      toast.error('Could not load admin dashboard', err instanceof Error ? err.message : undefined);
    } finally {
      if (!opts?.quiet) {
        const wait = Math.max(0, 450 - (Date.now() - started));
        if (wait) await new Promise((r) => window.setTimeout(r, wait));
        setBusy(false);
      }
    }
  }

  useWhenVisiblePoll(() => load({ quiet: true }), 45_000, true);

  const insights = useMemo(() => buildInsights(tenants), [tenants]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return tenants
      .filter((u) => {
        const blob = `${usernameOf(u)} ${u.email} ${u.organization?.name || ''} ${u.adminNote || ''}`.toLowerCase();
        return blob.includes(q);
      })
      .slice(0, 8);
  }, [query, tenants]);

  const s = data?.stats;

  const cards = [
    { label: 'Users', value: formatNumber(s?.users ?? 0), icon: Users, ico: 'bg-blue-50 text-blue-600' },
    { label: 'Workspaces', value: formatNumber(s?.workspaces ?? 0), icon: LayoutDashboard, ico: 'bg-orange-50 text-orange-600' },
    { label: 'Online', value: formatNumber(insights.online.length), icon: Wifi, ico: 'bg-emerald-50 text-emerald-600' },
    { label: 'Campaigns sent', value: formatNumber(s?.sent ?? 0), icon: Mail, ico: 'bg-amber-50 text-amber-600' },
    { label: 'Emails accepted', value: formatNumber(s?.emailsSent ?? 0), icon: Activity, ico: 'bg-sky-50 text-sky-600' },
    { label: 'Failed', value: formatNumber(s?.emailsFailed ?? 0), icon: AlertTriangle, ico: 'bg-rose-50 text-rose-600' },
  ];

  function jumpToUser(username: string) {
    navigate(`/admin/users?q=${encodeURIComponent(username)}`);
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (matches.length === 1) jumpToUser(usernameOf(matches[0]));
    else navigate(`/admin/users?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="if-admin-page">
      <div className="if-admin-hero">
        <div className="min-w-0 flex-1">
          <h1 className="if-admin-heading if-admin-title font-semibold">Dashboard overview</h1>
          <p className="if-admin-lede mt-2 max-w-3xl text-sm leading-relaxed">
            Created users only. Your operator mailer is not counted. On-device workspaces report send
            totals when the desktop app is online.
          </p>
          {ADMIN_UI_DEMO ? (
            <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-800">
              Layout demo data
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-800 hover:bg-slate-200 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <form className="if-admin-card flex flex-wrap items-center gap-2 px-4 py-3" onSubmit={onSearch}>
        <Search className="h-4 w-4 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a user, workspace, or note…"
          className="if-admin-muted min-w-0 flex-1 bg-transparent py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400"
        />
        <button type="submit" className="if-admin-btn if-admin-btn-ghost">
          Open
        </button>
        {matches.length ? (
          <div className="w-full space-y-1 pt-2">
            {matches.map((u) => (
              <button
                key={u.id}
                type="button"
                className="if-admin-surface flex w-full items-center justify-between gap-3 p-3 text-left"
                onClick={() => jumpToUser(usernameOf(u))}
              >
                <span>
                  <span className="font-semibold text-slate-900">{usernameOf(u)}</span>
                  <span className="if-admin-muted ml-2 text-sm">{u.organization?.name || '—'}</span>
                </span>
                <span className="text-xs font-bold uppercase text-teal-700">Open</span>
              </button>
            ))}
          </div>
        ) : null}
      </form>

      <div className="if-admin-kpis">
        {cards.map((c) => (
          <div key={c.label} className="if-admin-card if-admin-kpi p-3 sm:p-4">
            <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${c.ico}`}>
              <c.icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="if-admin-muted truncate text-sm">{c.label}</p>
              <p className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">{c.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="if-admin-boards">
        <Link to="/admin/users?filter=paid" className="if-admin-card if-admin-board-btn p-4">
          <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Paid now</p>
          <p className="mt-1 text-2xl font-extrabold text-emerald-700">{insights.paid}</p>
          <p className="if-admin-muted mt-1 text-sm">Click to renew or add time.</p>
        </Link>
        <Link to="/admin/users?filter=ending" className="if-admin-card if-admin-board-btn p-4">
          <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Ending in 7 days</p>
          <p className="mt-1 text-2xl font-extrabold text-amber-700">{insights.ending}</p>
          <p className="if-admin-muted mt-1 text-sm">Renew before they lose access.</p>
        </Link>
        <Link to="/admin/users?filter=ended" className="if-admin-card if-admin-board-btn p-4">
          <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Ended</p>
          <p className="mt-1 text-2xl font-extrabold text-rose-700">{insights.ended}</p>
          <p className="if-admin-muted mt-1 text-sm">Sign-in is blocked until you renew.</p>
        </Link>
      </div>

      <div className="if-admin-console">
        <div className="space-y-4">
          <section className="if-admin-card p-4 sm:p-6">
            <h2 className="if-admin-heading text-xl font-semibold sm:text-2xl">Online now</h2>
            <p className="if-admin-lede mt-1 text-sm">Last seen within two minutes.</p>
            <div className="mt-4 space-y-2">
              {insights.online.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="if-admin-surface flex w-full items-center justify-between gap-3 p-3 text-left"
                  onClick={() => jumpToUser(usernameOf(u))}
                >
                  <span className="font-semibold text-slate-900">{usernameOf(u)}</span>
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    Online
                  </span>
                </button>
              ))}
              {!insights.online.length ? (
                <p className="if-admin-muted py-4 text-center text-sm">No created users are online.</p>
              ) : null}
            </div>
          </section>

          <section className="if-admin-card p-4 sm:p-6">
            <h2 className="if-admin-heading text-xl font-semibold sm:text-2xl">Website management</h2>
            <p className="if-admin-lede mt-1 text-sm">Quick shortcuts for the parts of the dashboard you use most.</p>
            <div className="mt-5 space-y-3">
              {QUICK.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="if-admin-surface flex items-start justify-between gap-3 p-3 sm:p-4 transition-colors hover:bg-slate-100"
                >
                  <div className="flex min-w-0 gap-3">
                    <div className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-600">
                      <item.icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{item.title}</p>
                      <p className="if-admin-muted mt-1 text-sm">{item.description}</p>
                    </div>
                  </div>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                </Link>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section className="if-admin-card p-4 sm:p-6">
            <h2 className="if-admin-heading text-xl font-semibold sm:text-2xl">System</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="if-admin-surface p-4">
                <p className="if-admin-muted text-xs font-semibold uppercase tracking-wide">API</p>
                <p className="mt-1 text-lg font-extrabold text-emerald-700">
                  {busy && !data
                    ? 'Checking'
                    : data?.health?.status === 'ok' || data?.health?.status === 'up'
                      ? 'Up'
                      : data?.health?.status || 'Down'}
                </p>
              </div>
              <div className="if-admin-surface p-4">
                <p className="if-admin-muted text-xs font-semibold uppercase tracking-wide">Database</p>
                <p className="mt-1 text-lg font-extrabold text-emerald-700">
                  {busy && !data
                    ? 'Checking'
                    : data?.health?.database === 'up' || data?.health?.database === 'ok'
                      ? 'Up'
                      : data?.health?.database || 'Down'}
                </p>
              </div>
            </div>
            <h3 className="if-admin-heading mt-6 text-xl font-semibold">Recent campaigns</h3>
            <p className="if-admin-lede mt-1 text-sm">Created users only — each card is labeled with their username.</p>
            <div className="mt-4 space-y-3">
              {(data?.recentCampaigns || []).map((c) => {
                const username = c.user?.username || c.user?.name || '';
                if (!username) return null;
                return (
                  <div key={`${c.user?.email || 'u'}-${c.id}`} className="if-admin-surface p-4">
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-teal-50 text-sm font-extrabold text-teal-700">
                        {username.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="if-admin-muted text-[10px] font-bold uppercase tracking-wide">User</p>
                        <p className="truncate font-bold text-slate-900">{username}</p>
                      </div>
                    </div>
                    <p className="mt-3 font-medium text-slate-800">{c.name || 'Untitled'}</p>
                    <p className="if-admin-muted mt-1 text-sm">
                      {c.status} · {c.sentCount} sent
                    </p>
                  </div>
                );
              })}
              {!data?.recentCampaigns?.length ? (
                <p className="if-admin-muted py-6 text-center text-sm">
                  No sends from created users yet. After they send, the card shows their username, then the campaign.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
