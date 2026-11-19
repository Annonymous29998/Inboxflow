import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import { presenceLabel } from '@/lib/presence';
import { toast } from '@/stores/toast';
import { useWhenVisiblePoll } from '@/lib/admin-poll';
import { ADMIN_UI_DEMO, hydrateDemoUsers } from './admin-demo-data';
import {
  buildInsights,
  DAY_MS,
  residencyLabel,
  sentInWindow,
  subActive,
  type InsightUser,
  usernameOf,
  WEEK_MS,
} from './admin-insights';

type DetailKind = 'attention' | 'send' | 'residency';

const TABS: Array<{ id: DetailKind; to: string; end?: boolean; title: string; lede: string }> = [
  {
    id: 'attention',
    to: '/admin/health',
    end: true,
    title: 'Needs attention',
    lede: 'Failed sends, ended plans, deactivated accounts, and PCs that went quiet.',
  },
  {
    id: 'send',
    to: '/admin/health/sends',
    title: 'Send health',
    lede: 'Accepted volume from campaigns updated in the last day and week.',
  },
  {
    id: 'residency',
    to: '/admin/health/data',
    title: 'Where data lives',
    lede: 'On-device SQLite vs cloud. Stale means the PC has not pulsed in 30 minutes.',
  },
];

function formatSubEnd(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sectionFromPath(pathname: string): DetailKind {
  if (pathname.startsWith('/admin/health/sends')) return 'send';
  if (pathname.startsWith('/admin/health/data')) return 'residency';
  return 'attention';
}

export function AdminHealthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const kind = sectionFromPath(location.pathname);
  const tab = TABS.find((t) => t.id === kind) || TABS[0];
  const [tenants, setTenants] = useState<InsightUser[]>([]);
  const [detail, setDetail] = useState<{ user: InsightUser; kind: DetailKind; reasons?: string[] } | null>(null);

  async function load() {
    if (ADMIN_UI_DEMO) {
      setTenants(hydrateDemoUsers());
      return;
    }
    const d = await api.get<{ users: Array<InsightUser & { role?: string }> }>('/api/admin/users');
    setTenants((d.users || []).filter((u) => u.role === 'USER'));
  }

  useWhenVisiblePoll(() => {
    load().catch((err) => {
      if (!ADMIN_UI_DEMO) toast.error('Could not load health', err instanceof Error ? err.message : undefined);
    });
  }, 45_000, true);

  const insights = useMemo(() => buildInsights(tenants), [tenants]);

  function open(user: InsightUser, reasons?: string[]) {
    setDetail({ user, kind, reasons });
  }

  const attentionRows = insights.attention;
  const sendRows = insights.sendRows;
  const dataRows = tenants;

  return (
    <div className="if-admin-page">
      <div>
        <h1 className="if-admin-heading if-admin-title font-semibold">{tab.title}</h1>
        <p className="if-admin-lede mt-2 max-w-3xl text-sm">{tab.lede}</p>
        {ADMIN_UI_DEMO ? (
          <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-800">
            Layout demo data
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              isActive
                ? 'rounded-full bg-teal-700 px-3 py-1.5 text-sm font-bold text-white'
                : 'rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-200 hover:text-slate-900'
            }
          >
            {item.title}
            {item.id === 'attention' ? ` · ${attentionRows.length}` : null}
            {item.id === 'send' ? ` · ${formatNumber(insights.sent24h)}` : null}
            {item.id === 'residency' ? ` · ${insights.stale} stale` : null}
          </NavLink>
        ))}
      </div>

      <section className="if-admin-card overflow-hidden">
        <div className="if-admin-table-wrap">
          {kind === 'attention' ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="if-admin-muted border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Workspace</th>
                  <th className="px-3 py-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {attentionRows.map(({ user, reasons }) => (
                  <tr
                    key={user.id}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    onClick={() => open(user, reasons)}
                  >
                    <td className="px-3 py-3 font-semibold text-slate-900">{usernameOf(user)}</td>
                    <td className="if-admin-muted px-3 py-3">{user.organization?.name || '—'}</td>
                    <td className="px-3 py-3 text-xs font-bold uppercase tracking-wide text-amber-800">{reasons.join(' · ')}</td>
                  </tr>
                ))}
                {!attentionRows.length ? (
                  <tr>
                    <td colSpan={3} className="if-admin-muted px-3 py-10 text-center">
                      Nothing needs attention.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : null}

          {kind === 'send' ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="if-admin-muted border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Workspace</th>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">24h</th>
                  <th className="px-3 py-2 font-medium">7d</th>
                  <th className="px-3 py-2 font-medium">Failed</th>
                </tr>
              </thead>
              <tbody>
                {sendRows.map((user) => (
                  <tr
                    key={user.id}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    onClick={() => open(user)}
                  >
                    <td className="px-3 py-3 font-semibold text-slate-900">{user.organization?.name || usernameOf(user)}</td>
                    <td className="px-3 py-3 text-teal-700">{usernameOf(user)}</td>
                    <td className="px-3 py-3">{formatNumber(sentInWindow(user, DAY_MS))}</td>
                    <td className="px-3 py-3">{formatNumber(sentInWindow(user, WEEK_MS))}</td>
                    <td className="px-3 py-3 font-semibold text-rose-700">{formatNumber(user.pulse?.emailsFailed || 0)}</td>
                  </tr>
                ))}
                {!sendRows.length ? (
                  <tr>
                    <td colSpan={5} className="if-admin-muted px-3 py-10 text-center">
                      No send reports yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : null}

          {kind === 'residency' ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="if-admin-muted border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Workspace</th>
                  <th className="px-3 py-2 font-medium">Data</th>
                  <th className="px-3 py-2 font-medium">Presence</th>
                </tr>
              </thead>
              <tbody>
                {dataRows.map((user) => {
                  const tag = residencyLabel(user);
                  const presence = presenceLabel(user.pulse?.lastSeenAt, user.lastLoginAt);
                  return (
                    <tr
                      key={user.id}
                      className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      onClick={() => open(user)}
                    >
                      <td className="px-3 py-3 font-semibold text-slate-900">{usernameOf(user)}</td>
                      <td className="if-admin-muted px-3 py-3">{user.organization?.name || '—'}</td>
                      <td className="px-3 py-3">
                        <span
                          className={
                            tag === 'Stale PC'
                              ? 'rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold uppercase text-amber-800'
                              : tag === 'On PC'
                                ? 'rounded-full bg-teal-50 px-2 py-0.5 text-xs font-bold uppercase text-teal-800'
                                : 'rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase text-slate-700'
                          }
                        >
                          {tag}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {presence.online ? (
                          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                            Online
                          </span>
                        ) : (
                          <span className="if-admin-muted">{presence.text}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!dataRows.length ? (
                  <tr>
                    <td colSpan={4} className="if-admin-muted px-3 py-10 text-center">
                      No created users yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      {detail
        ? createPortal(
            <div className="if-admin-modal-overlay">
              <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => setDetail(null)} />
              <div className="if-admin-modal if-admin-modal-wide">
                <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
                  <div>
                    <p className="if-admin-muted text-xs font-bold uppercase tracking-[0.16em]">{tab.title}</p>
                    <h2 className="if-admin-heading mt-1 text-2xl font-semibold">{usernameOf(detail.user)}</h2>
                    <p className="if-admin-muted mt-1 text-sm">{detail.user.organization?.name || '—'}</p>
                  </div>
                  <button
                    type="button"
                    className="grid h-9 w-9 place-items-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:text-slate-900"
                    onClick={() => setDetail(null)}
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-4 p-5">
                  {detail.reasons?.length ? (
                    <p className="text-xs font-bold uppercase tracking-wide text-amber-800">{detail.reasons.join(' · ')}</p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Account</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {detail.user.status === 'ACTIVE' ? 'Active' : 'Deactivated'}
                      </p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Subscription</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {subActive(detail.user.subscription) ? 'Paid' : 'Ended'} ·{' '}
                        {formatSubEnd(detail.user.subscription?.currentPeriodEnd)}
                      </p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Data</p>
                      <p className="mt-1 font-semibold text-slate-900">{residencyLabel(detail.user)}</p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Presence</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {presenceLabel(detail.user.pulse?.lastSeenAt, detail.user.lastLoginAt).text}
                      </p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Last 24 hours</p>
                      <p className="mt-1 font-semibold text-slate-900">{formatNumber(sentInWindow(detail.user, DAY_MS))}</p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Last 7 days</p>
                      <p className="mt-1 font-semibold text-slate-900">{formatNumber(sentInWindow(detail.user, WEEK_MS))}</p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Accepted</p>
                      <p className="mt-1 font-semibold text-slate-900">{formatNumber(detail.user.pulse?.emailsSent || 0)}</p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Failed</p>
                      <p className="mt-1 font-semibold text-rose-700">{formatNumber(detail.user.pulse?.emailsFailed || 0)}</p>
                    </div>
                  </div>
                  {detail.user.adminNote ? (
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Admin note</p>
                      <p className="mt-1 text-sm text-slate-800">{detail.user.adminNote}</p>
                    </div>
                  ) : null}
                  <div>
                    <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Recent campaigns</p>
                    <div className="mt-2 space-y-2">
                      {(detail.user.pulse?.recentCampaigns || []).map((c, i) => (
                        <div key={c.id || `${c.name}-${i}`} className="if-admin-surface p-3">
                          <p className="font-semibold text-slate-900">{c.name || 'Untitled'}</p>
                          <p className="if-admin-muted mt-1 text-sm">
                            {c.status || '—'} · {formatNumber(c.sentCount)} sent
                          </p>
                        </div>
                      ))}
                      {!detail.user.pulse?.recentCampaigns?.length ? (
                        <p className="if-admin-muted text-sm">No recent campaigns on this workspace.</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="if-admin-btn if-admin-btn-primary"
                      onClick={() => navigate(`/admin/users?q=${encodeURIComponent(usernameOf(detail.user))}`)}
                    >
                      Open in Users
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
