import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Copy, KeyRound, Plus, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { confirmDialog } from '@/stores/confirm';
import { useAuthStore } from '@/stores/auth';
import { formatNumber } from '@/lib/utils';
import { presenceLabel } from '@/lib/presence';
import { useWhenVisiblePoll } from '@/lib/admin-poll';
import { ADMIN_UI_DEMO, bumpSubscription, DEMO_SESSIONS, hydrateDemoUsers, isDemoId } from './admin-demo-data';
import { describeUserAgent } from '@/lib/user-agent';
import { subEndingSoon } from './admin-insights';
import { licenseConfigJson } from '@/lib/desktop-license-config';
import { publicBindPcUrl } from '@/lib/bind-pc';

type SubscriptionInfo = {
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  active?: boolean;
};

type AdminUser = {
  id: string;
  email: string;
  username?: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  lastLoginAt?: string | null;
  createdAt?: string;
  organization?: { name: string } | null;
  onDevice?: boolean;
  boundIp?: string | null;
  boundAt?: string | null;
  licenseBound?: boolean;
  adminNote?: string;
  subscription?: SubscriptionInfo | null;
  pulse?: {
    lastSeenAt?: string | null;
    emailsSent?: number;
    emailsFailed?: number;
    campaignsSent?: number;
  };
  sessions?: Array<{
    id: string;
    userAgent: string;
    ipAddress: string;
    createdAt: string;
    expiresAt?: string;
    current?: boolean;
  }>;
};

function generateLicenseKey() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function usernameOf(u: AdminUser) {
  return u.username || u.firstName || u.email.split('@')[0] || u.email;
}

function bindLinkFor(username: string) {
  return publicBindPcUrl(username);
}

async function copyBindLink(username: string) {
  const url = bindLinkFor(username);
  await navigator.clipboard.writeText(url);
  toast.success('Copied Bind PC link', url);
}

function subscriptionActive(sub?: SubscriptionInfo | null) {
  if (!sub) return false;
  if (sub.active === false) return false;
  const end = Date.parse(sub.currentPeriodEnd);
  return Number.isFinite(end) && end > Date.now() && sub.status !== 'EXPIRED' && sub.status !== 'CANCELLED';
}

type UserAction = 'status' | 'renew' | 'add' | 'unbind' | 'bindlink';

function UserActionMenu({
  status,
  label,
  bound,
  onPick,
}: {
  status: string;
  label: string;
  bound?: boolean;
  onPick: (action: UserAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 16 });

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    const next = !open;
    if (next) {
      const useSheet = window.matchMedia('(max-width: 639px)').matches;
      setSheet(useSheet);
      if (!useSheet && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setPos({ top: r.bottom + 6, right: Math.max(12, window.innerWidth - r.right) });
      }
    }
    setOpen(next);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const items: { id: UserAction; text: string }[] = [
    { id: 'bindlink', text: 'Copy bind link' },
    { id: 'status', text: status === 'SUSPENDED' ? 'Activate' : 'Deactivate' },
    { id: 'renew', text: 'Renew' },
    { id: 'add', text: 'Add time' },
    ...(bound ? [{ id: 'unbind' as const, text: 'Unbind PC' }] : []),
  ];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="if-admin-btn if-admin-btn-ghost if-admin-action-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={toggle}
      >
        Actions
        <ChevronDown className="h-4 w-4 shrink-0" />
      </button>
      {open
        ? createPortal(
            <div className="if-admin-modal-overlay" style={{ background: sheet ? 'rgba(15,23,42,0.45)' : 'transparent' }}>
              <button type="button" className="absolute inset-0" aria-label="Close actions" onClick={() => setOpen(false)} />
              <div
                className="if-admin-menu-panel"
                data-sheet={sheet ? 'true' : 'false'}
                style={sheet ? undefined : { top: pos.top, right: pos.right }}
                role="menu"
              >
                {sheet ? (
                  <p className="if-admin-muted px-4 pt-3 text-xs font-bold uppercase tracking-wide">Choose action</p>
                ) : null}
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="if-admin-menu-item"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onPick(item.id);
                    }}
                  >
                    {item.text}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const NOTES_KEY = 'inboxflow:admin-notes';

function readDemoNotes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDemoNote(id: string, note: string) {
  const next = { ...readDemoNotes(), [id]: note };
  localStorage.setItem(NOTES_KEY, JSON.stringify(next));
}

function formatSubEnd(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AdminUsersPage() {
  const me = useAuthStore((s) => s.user);
  const [params, setParams] = useSearchParams();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState(() => params.get('q') || '');
  const [modalOpen, setModalOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [detail, setDetail] = useState<AdminUser | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [editUsername, setEditUsername] = useState('');
  const [editWorkspace, setEditWorkspace] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ username: string; licenseKey: string } | null>(null);
  const [resetIssued, setResetIssued] = useState<{ username: string; licenseKey: string } | null>(null);
  const [addFor, setAddFor] = useState<AdminUser | null>(null);
  const [addMonths, setAddMonths] = useState(1);
  const filter = params.get('filter') || '';

  async function load() {
    if (ADMIN_UI_DEMO) {
      const notes = readDemoNotes();
      setUsers(
        hydrateDemoUsers().map((u) => ({
          ...u,
          adminNote: notes[u.id] ?? u.adminNote,
        })),
      );
      return;
    }
    const d = await api.get<{ users: AdminUser[] }>('/api/admin/users');
    setUsers((d.users || []).filter((u) => u.role === 'USER'));
  }

  useWhenVisiblePoll(() => {
    load().catch((err) => {
      if (!ADMIN_UI_DEMO) toast.error('Could not load users', err instanceof Error ? err.message : undefined);
    });
  }, 45_000, true);

  useEffect(() => {
    setSearch(params.get('q') || '');
  }, [params]);

  const rows = useMemo(() => {
    let list = users;
    if (filter === 'paid') list = list.filter((u) => subscriptionActive(u.subscription));
    if (filter === 'ending') list = list.filter((u) => subEndingSoon(u.subscription));
    if (filter === 'ended') list = list.filter((u) => !subscriptionActive(u.subscription));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((u) => {
      const blob = `${usernameOf(u)} ${u.email} ${u.organization?.name || ''} ${u.status} ${u.adminNote || ''}`.toLowerCase();
      return blob.includes(q);
    });
  }, [users, search, filter]);

  function openCreate() {
    setUsername('');
    setWorkspace('');
    setLicenseKey('');
    setIssued(null);
    setModalOpen(true);
  }

  function fillEdit(u: AdminUser) {
    setEditUsername(usernameOf(u));
    setEditWorkspace(u.organization?.name || '');
    setEditNote(u.adminNote || '');
  }

  function patchLocal(id: string, patch: Partial<AdminUser>) {
    setUsers((cur) => cur.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDetail((d) => (d && d.id === id ? { ...d, ...patch } : d));
  }

  async function openDetail(u: AdminUser) {
    fillEdit(u);
    setDevicesOpen(false);
    if (ADMIN_UI_DEMO || isDemoId(u.id)) {
      setDetail({ ...u, sessions: DEMO_SESSIONS[u.id] || [] });
      return;
    }
    setDetailBusy(true);
    setDetail(u);
    try {
      const d = await api.get<{ user: AdminUser }>('/api/admin/users/' + u.id);
      setDetail(d.user);
      fillEdit(d.user);
    } catch (err) {
      toast.error('Could not load user details', err instanceof Error ? err.message : undefined);
    } finally {
      setDetailBusy(false);
    }
  }

  async function createUser(e: FormEvent) {
    e.preventDefault();
    const login = username.trim();
    const key = licenseKey.trim() || generateLicenseKey();
    if (!login) {
      toast.error('Choose a username');
      return;
    }
    setBusy(true);
    try {
      if (!licenseKey.trim()) setLicenseKey(key);
      const data = await api.post<{
        username?: string;
        licenseKey?: string;
        password?: string;
        user: { email: string; firstName: string };
      }>('/api/admin/users', {
        username: login,
        licenseKey: key,
        password: key,
        organizationName: workspace.trim() || login,
      });
      const issuedKey = data.licenseKey || data.password || key;
      const issuedUser = data.username || login;
      setIssued({ username: issuedUser, licenseKey: issuedKey });
      toast.success('User created with a 1-month subscription — copy the license key now');
      await load();
    } catch (err) {
      toast.error('Could not create user', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(u: AdminUser) {
    if (u.id === me?.id) return;
    const next = u.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    const activating = next === 'ACTIVE';
    if (
      !(await confirmDialog({
        title: activating ? `Activate ${usernameOf(u)}?` : `Deactivate ${usernameOf(u)}?`,
        description: activating
          ? 'They can sign in again if their subscription is still valid.'
          : 'They will not be able to sign in until you activate them. Their remaining subscription days are kept.',
        confirmText: activating ? 'Activate' : 'Deactivate',
        destructive: !activating,
      }))
    ) {
      return;
    }
    if (isDemoId(u.id)) {
      patchLocal(u.id, { status: next });
      toast.success(activating ? 'User activated' : 'User deactivated');
      return;
    }
    try {
      await api.patch(`/api/admin/users/${u.id}`, { status: next });
      toast.success(activating ? 'User activated' : 'User deactivated');
      patchLocal(u.id, { status: next });
      await load();
    } catch (err) {
      toast.error('Could not update user', err instanceof Error ? err.message : undefined);
    }
  }

  async function addSubscriptionMonths(u: AdminUser, months: number, label: string) {
    if (isDemoId(u.id)) {
      const subscription = bumpSubscription(u.subscription ?? undefined, months);
      patchLocal(u.id, { subscription });
      toast.success(`${label} for ${usernameOf(u)}`);
      return;
    }
    try {
      await api.patch(`/api/admin/users/${u.id}`, { addMonths: months });
      toast.success(`${label} for ${usernameOf(u)}`);
      await load();
    } catch (err) {
      toast.error('Could not update subscription', err instanceof Error ? err.message : undefined);
    }
  }

  async function renewSubscription(u: AdminUser) {
    if (
      !(await confirmDialog({
        title: `Renew ${usernameOf(u)}?`,
        description: 'Adds 1 paid month. If the plan already has time left, the extra month starts after the current end date.',
        confirmText: 'Renew 1 month',
      }))
    ) {
      return;
    }
    await addSubscriptionMonths(u, 1, 'Renewed 1 month');
  }

  async function saveDetails(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    const nextUser = editUsername.trim();
    const nextWorkspace = editWorkspace.trim();
    if (!nextUser) {
      toast.error('Username is required');
      return;
    }
    setEditBusy(true);
    try {
      if (isDemoId(detail.id)) {
        writeDemoNote(detail.id, editNote);
        patchLocal(detail.id, {
          username: nextUser,
          firstName: nextUser,
          email: `${nextUser.toLowerCase()}@inboxflow.io`,
          organization: { name: nextWorkspace || nextUser },
          adminNote: editNote,
        });
        toast.success('User updated');
        return;
      }
      await api.patch(`/api/admin/users/${detail.id}`, {
        username: nextUser,
        organizationName: nextWorkspace || nextUser,
        adminNote: editNote,
      });
      patchLocal(detail.id, {
        username: nextUser,
        firstName: nextUser,
        organization: { name: nextWorkspace || nextUser },
        adminNote: editNote,
      });
      toast.success('User updated');
      await load();
    } catch (err) {
      toast.error('Could not save user', err instanceof Error ? err.message : undefined);
    } finally {
      setEditBusy(false);
    }
  }

  async function resetLicense(u: AdminUser) {
    if (
      !(await confirmDialog({
        title: `Reset license for ${usernameOf(u)}?`,
        description: 'They must sign in with the new key. The old key stops working. Copy the new key now — it is shown once.',
      }))
    ) {
      return;
    }
    try {
      if (isDemoId(u.id)) {
        const key = generateLicenseKey();
        setDetail(null);
        setResetIssued({ username: usernameOf(u), licenseKey: key });
        toast.success('New license key — copy it now');
        return;
      }
      const data = await api.patch<{ licenseKey?: string }>(`/api/admin/users/${u.id}`, { resetLicense: true });
      if (!data.licenseKey) {
        toast.error('License was reset but the key was not returned');
        return;
      }
      setDetail(null);
      setResetIssued({ username: usernameOf(u), licenseKey: data.licenseKey });
      toast.success('New license key — copy it now');
    } catch (err) {
      toast.error('Could not reset license', err instanceof Error ? err.message : undefined);
    }
  }

  async function unbindLicense(u: AdminUser) {
    if (
      !(await confirmDialog({
        title: `Unbind ${usernameOf(u)}?`,
        description: 'They can activate the same license on a new PC. Sessions on the old PC stop.',
      }))
    ) {
      return;
    }
    try {
      if (isDemoId(u.id)) {
        toast.success('License unbound — they can activate on a new PC');
        setDetail((d) => (d?.id === u.id ? { ...d, boundIp: null, boundAt: null, licenseBound: false } : d));
        return;
      }
      await api.patch(`/api/admin/users/${u.id}`, { unbindLicense: true });
      toast.success('License unbound — they can activate on a new PC');
      await load();
      setDetail((d) => (d?.id === u.id ? { ...d, boundIp: null, boundAt: null, licenseBound: false } : d));
    } catch (err) {
      toast.error('Could not unbind', err instanceof Error ? err.message : undefined);
    }
  }

  function runRowAction(u: AdminUser, action: string) {
    if (action === 'bindlink') {
      void copyBindLink(usernameOf(u));
      return;
    }
    if (action === 'status') void toggleStatus(u);
    if (action === 'renew') void renewSubscription(u);
    if (action === 'unbind') void unbindLicense(u);
    if (action === 'add') {
      setAddFor(u);
      setAddMonths(1);
    }
  }

  return (
    <div className="if-admin-page">
      <div className="if-admin-hero">
        <div>
          <h1 className="if-admin-heading if-admin-title font-semibold">Users</h1>
          <p className="if-admin-lede mt-2 text-sm">
            {users.length} customer{users.length === 1 ? '' : 's'}. Creating a user starts a 1-month paid
            subscription. Username is the login. License key is the password.
          </p>
          {ADMIN_UI_DEMO ? (
            <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-800">
              Layout demo data
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-[#3dff3d] px-4 py-2.5 text-sm font-extrabold text-[#050805] shadow-[0_8px_20px_rgba(61,255,61,0.28)] hover:brightness-110"
        >
          <Plus className="h-4 w-4" />
          Create user
        </button>
      </div>

      <section className="if-admin-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => {
              const value = e.target.value;
              setSearch(value);
              const next = new URLSearchParams(params);
              if (value.trim()) next.set('q', value.trim());
              else next.delete('q');
              setParams(next, { replace: true });
            }}
            placeholder="Search customers…"
            className="if-admin-muted min-w-0 flex-1 bg-transparent py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          <span className="if-admin-muted text-xs font-bold uppercase tracking-wide">{rows.length} shown</span>
          {filter ? (
            <button
              type="button"
              className="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-teal-800"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('filter');
                setParams(next, { replace: true });
              }}
            >
              {filter === 'paid' ? 'Paid now' : filter === 'ending' ? 'Ending in 7 days' : 'Ended'} · Clear
            </button>
          ) : null}
        </div>
        <div className="if-admin-table-wrap">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="if-admin-muted border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Username</th>
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Presence</th>
                <th className="px-3 py-2 font-medium">License</th>
                <th className="px-3 py-2 font-medium">Subscription</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u, i) => (
                <tr
                  key={u.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => void openDetail(u)}
                >
                  <td className="if-admin-muted px-3 py-3">{i + 1}</td>
                  <td className="px-3 py-3">
                    <p className="font-medium text-slate-900">{usernameOf(u)}</p>
                  </td>
                  <td className="px-3 py-3 font-semibold text-teal-700">{usernameOf(u)}</td>
                  <td className="px-3 py-2.5">{u.organization?.name || '—'}</td>
                  <td className="px-3 py-2.5 font-semibold text-emerald-700">{formatNumber(u.pulse?.emailsSent ?? 0)}</td>
                  <td className="px-3 py-2.5">
                    {(() => {
                      const p = presenceLabel(u.pulse?.lastSeenAt, u.lastLoginAt);
                      return p.online ? (
                        <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          Online
                        </span>
                      ) : (
                        <span className="if-admin-muted">{p.text}</span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2.5">
                    {u.licenseBound || u.boundIp ? (
                      <div>
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-bold uppercase text-emerald-700">
                          Activated
                        </span>
                        <p className="if-admin-muted mt-1 text-xs">{u.boundIp}</p>
                      </div>
                    ) : (
                      <div>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase text-slate-600">
                          Not bound
                        </span>
                        <button
                          type="button"
                          className="mt-1 block text-left text-xs font-semibold text-teal-700 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copyBindLink(usernameOf(u));
                          }}
                        >
                          Copy bind link
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {(() => {
                      const live = subscriptionActive(u.subscription);
                      return (
                        <div>
                          <span
                            className={
                              live
                                ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-bold uppercase text-emerald-700'
                                : 'rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold uppercase text-amber-800'
                            }
                          >
                            {live ? 'Paid' : 'Ended'}
                          </span>
                          <p className="if-admin-muted mt-1 text-xs">
                            {live ? 'Until' : 'Ended'} {formatSubEnd(u.subscription?.currentPeriodEnd)}
                          </p>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={
                        u.status === 'ACTIVE'
                          ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-bold uppercase text-emerald-700'
                          : 'rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold uppercase text-slate-700'
                      }
                    >
                      {u.status === 'ACTIVE' ? 'Active' : 'Deactivated'}
                    </span>
                  </td>
                  <td className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {u.id !== me?.id ? (
                      <UserActionMenu
                        status={u.status}
                        bound={Boolean(u.licenseBound || u.boundIp)}
                        label={`Actions for ${usernameOf(u)}`}
                        onPick={(action) => runRowAction(u, action)}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                    <td colSpan={10} className="if-admin-muted px-3 py-10 text-center">
                    No customers yet. Create a user to start a 1-month subscription.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {modalOpen
        ? createPortal(
            <div className="if-admin-modal-overlay">
              <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => setModalOpen(false)} />
              <div className="if-admin-modal">
                <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
                  <div>
                    <p className="if-admin-muted text-xs font-bold uppercase tracking-[0.16em]">New customer</p>
                    <h2 className="if-admin-heading mt-1 text-2xl font-semibold">Create user</h2>
                  </div>
                  <button
                    type="button"
                    className="grid h-9 w-9 place-items-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:text-slate-900"
                    onClick={() => setModalOpen(false)}
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {issued ? (
                  <div className="space-y-3 p-5">
                    <p className="if-admin-muted text-sm">Give these to the user once. They bind in the browser on the Bind PC link, then open the EXE.</p>
                    <div className="if-admin-surface p-3 text-sm">
                      <p>
                        Username:{' '}
                        <span className="font-semibold text-teal-800">{issued.username}</span>
                      </p>
                      <p className="mt-1">
                        License key:{' '}
                        <span className="font-semibold text-teal-800">{issued.licenseKey}</span>
                      </p>
                      <p className="mt-1 break-all">
                        Bind PC:{' '}
                        <span className="font-semibold text-teal-800">{bindLinkFor(issued.username)}</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="if-admin-btn if-admin-btn-ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            `Username: ${issued.username}\nLicense key: ${issued.licenseKey}\nBind PC: ${bindLinkFor(issued.username)}`,
                          );
                          toast.success('Copied username, license key, and bind link');
                        }}
                      >
                        <Copy className="h-4 w-4" />
                        Copy
                      </button>
                      <button
                        type="button"
                        className="if-admin-btn if-admin-btn-ghost"
                        onClick={() => void copyBindLink(issued.username)}
                      >
                        <Copy className="h-4 w-4" />
                        Copy bind link
                      </button>
                      <button
                        type="button"
                        className="if-admin-btn if-admin-btn-ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(licenseConfigJson(issued.username, issued.licenseKey));
                          toast.success('Copied config.json');
                        }}
                      >
                        <Copy className="h-4 w-4" />
                        Copy config.json
                      </button>
                      <button type="button" className="if-admin-btn if-admin-btn-primary" onClick={() => setModalOpen(false)}>
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  <form className="space-y-4 p-5" onSubmit={(e) => void createUser(e)}>
                    <div>
                      <label className="if-admin-field" htmlFor="if-admin-username">
                        Username
                      </label>
                      <input
                        id="if-admin-username"
                        className="if-admin-input"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="e.g. acme-mail"
                        autoFocus
                        required
                        minLength={3}
                        maxLength={32}
                        pattern="[a-zA-Z0-9._-]+"
                        autoComplete="off"
                      />
                      <p className="if-admin-muted mt-1 text-[11px]">This is what they type on the login screen.</p>
                    </div>
                    <div>
                      <label className="if-admin-field" htmlFor="if-admin-workspace">
                        Workspace
                      </label>
                      <input
                        id="if-admin-workspace"
                        className="if-admin-input"
                        value={workspace}
                        onChange={(e) => setWorkspace(e.target.value)}
                        placeholder="e.g. Nova Outreach"
                      />
                      <p className="if-admin-muted mt-1 text-[11px]">Shown on the users table. Defaults to the username if left blank.</p>
                    </div>
                    <div>
                      <label className="if-admin-field" htmlFor="if-admin-license">
                        License key
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          id="if-admin-license"
                          className="if-admin-input min-w-0 flex-1 font-mono"
                          value={licenseKey}
                          onChange={(e) => setLicenseKey(e.target.value)}
                          placeholder="9065C339DA0723E8"
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="if-admin-btn if-admin-btn-ghost shrink-0"
                          onClick={() => setLicenseKey(generateLicenseKey())}
                        >
                          <KeyRound className="h-4 w-4" />
                          Generate
                        </button>
                      </div>
                      <p className="if-admin-muted mt-1 text-[11px]">
                        This is their password. Creating them starts a paid 1-month subscription.
                      </p>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="if-admin-btn if-admin-btn-ghost" onClick={() => setModalOpen(false)}>
                        Cancel
                      </button>
                      <button type="submit" className="if-admin-btn if-admin-btn-primary" disabled={busy || !username.trim()}>
                        {busy ? 'Creating…' : 'Create user'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}

      {detail
        ? createPortal(
            <div className="if-admin-modal-overlay">
              <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => setDetail(null)} />
              <div className="if-admin-modal if-admin-modal-wide">
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                  <div className="min-w-0">
                    <p className="if-admin-muted text-xs font-bold uppercase tracking-[0.16em]">Customer</p>
                    <h2 className="if-admin-heading mt-1 text-2xl font-semibold">{usernameOf(detail)}</h2>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {detail.id !== me?.id ? (
                      <UserActionMenu
                        status={detail.status}
                        bound={Boolean(detail.licenseBound || detail.boundIp)}
                        label="User actions"
                        onPick={(action) => runRowAction(detail, action)}
                      />
                    ) : null}
                    <button
                      type="button"
                      className="grid h-9 w-9 place-items-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:text-slate-900"
                      onClick={() => setDetail(null)}
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="space-y-5 p-5">
                  {detailBusy ? <p className="if-admin-muted text-sm">Loading details…</p> : null}
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void saveDetails(e)}>
                    <div>
                      <label className="if-admin-field" htmlFor="if-admin-edit-username">
                        Username
                      </label>
                      <input
                        id="if-admin-edit-username"
                        className="if-admin-input"
                        value={editUsername}
                        onChange={(e) => setEditUsername(e.target.value)}
                        minLength={3}
                        maxLength={32}
                        pattern="[a-zA-Z0-9._-]+"
                        required
                      />
                    </div>
                    <div>
                      <label className="if-admin-field" htmlFor="if-admin-edit-workspace">
                        Workspace
                      </label>
                      <input
                        id="if-admin-edit-workspace"
                        className="if-admin-input"
                        value={editWorkspace}
                        onChange={(e) => setEditWorkspace(e.target.value)}
                      />
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Account</p>
                      <p className="mt-1 font-semibold text-slate-900">{detail.status === 'ACTIVE' ? 'Active' : 'Deactivated'}</p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Subscription</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {subscriptionActive(detail.subscription) ? 'Paid' : 'Ended'} · {formatSubEnd(detail.subscription?.currentPeriodEnd)}
                      </p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">License</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {detail.licenseBound || detail.boundIp ? 'Activated' : 'Not bound'}
                      </p>
                      {detail.boundIp ? (
                        <p className="if-admin-muted mt-1 text-xs">
                          {detail.boundIp}
                          {detail.boundAt ? ` · ${new Date(detail.boundAt).toLocaleDateString()}` : ''}
                        </p>
                      ) : (
                        <p className="if-admin-muted mt-1 text-xs">Waiting for Bind PC in the browser on their bind link</p>
                      )}
                      <button
                        type="button"
                        className="if-admin-btn if-admin-btn-ghost mt-2"
                        onClick={() => void copyBindLink(usernameOf(detail))}
                      >
                        <Copy className="h-4 w-4" />
                        Copy bind link
                      </button>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Data</p>
                      <p className="mt-1 font-semibold text-slate-900">{detail.onDevice ? 'Kept on their PC' : 'Cloud workspace'}</p>
                    </div>
                    <div className="if-admin-surface p-3">
                      <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Last login</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {detail.lastLoginAt ? new Date(detail.lastLoginAt).toLocaleString() : 'Never'}
                      </p>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="if-admin-field" htmlFor="if-admin-edit-note">
                        Admin note
                      </label>
                      <textarea
                        id="if-admin-edit-note"
                        className="if-admin-input min-h-[88px]"
                        maxLength={500}
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="Private note for operators. The user never sees this."
                      />
                    </div>
                    <div className="sm:col-span-2 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="if-admin-btn if-admin-btn-ghost"
                        onClick={() => void resetLicense(detail)}
                      >
                        Reset license
                      </button>
                      <button type="submit" className="if-admin-btn if-admin-btn-primary" disabled={editBusy}>
                        {editBusy ? 'Saving…' : 'Save details'}
                      </button>
                    </div>
                  </form>
                  <div>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 text-left"
                      aria-expanded={devicesOpen}
                      onClick={() => setDevicesOpen((v) => !v)}
                    >
                      <span>
                        <h3 className="if-admin-heading text-lg font-semibold">Devices</h3>
                        <p className="if-admin-muted mt-1 text-sm">
                          {(detail.sessions || []).length} session{(detail.sessions || []).length === 1 ? '' : 's'}
                        </p>
                      </span>
                      <ChevronDown className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${devicesOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {devicesOpen ? (
                      <div className="mt-3 space-y-2">
                        <p className="if-admin-muted text-sm">Sign-in sessions, browser, OS, and IP from their user agent.</p>
                        {(detail.sessions || []).map((s) => {
                          const agent = describeUserAgent(s.userAgent);
                          return (
                            <div key={s.id} className="if-admin-surface p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-semibold text-slate-900">{agent.summary}</p>
                                {s.current ? (
                                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                                    Current
                                  </span>
                                ) : null}
                              </div>
                              <p className="if-admin-muted mt-1 break-all text-xs">{s.userAgent || 'No user agent recorded'}</p>
                              <p className="if-admin-muted mt-1 text-xs">
                                IP {s.ipAddress || '—'} · {new Date(s.createdAt).toLocaleString()}
                              </p>
                            </div>
                          );
                        })}
                        {!detail.sessions?.length && !detailBusy ? (
                          <p className="if-admin-muted text-sm">No sign-in devices yet. They appear after the user logs in.</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {addFor
        ? createPortal(
            <div className="if-admin-modal-overlay">
              <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => setAddFor(null)} />
              <div className="if-admin-modal">
                <div className="border-b border-slate-200 px-5 py-4">
                  <p className="if-admin-muted text-xs font-bold uppercase tracking-[0.16em]">Subscription</p>
                  <h2 className="if-admin-heading mt-1 text-2xl font-semibold">Add time for {usernameOf(addFor)}</h2>
                  <p className="if-admin-muted mt-2 text-sm">
                    Extra months stack on the current end date. If it already ended, they start today.
                  </p>
                </div>
                <div className="space-y-4 p-5">
                  <div>
                    <label className="if-admin-field" htmlFor="if-admin-add-months">
                      Months to add
                    </label>
                    <select
                      id="if-admin-add-months"
                      className="if-admin-input"
                      value={addMonths}
                      onChange={(e) => setAddMonths(Number(e.target.value))}
                    >
                      {[1, 2, 3, 6, 12].map((n) => (
                        <option key={n} value={n}>
                          {n} month{n === 1 ? '' : 's'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" className="if-admin-btn if-admin-btn-ghost" onClick={() => setAddFor(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="if-admin-btn if-admin-btn-primary"
                      onClick={() => {
                        const target = addFor;
                        const months = addMonths;
                        setAddFor(null);
                        void addSubscriptionMonths(target, months, `Added ${months} month${months === 1 ? '' : 's'}`);
                      }}
                    >
                      Add to subscription
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {resetIssued
        ? createPortal(
            <div className="if-admin-modal-overlay">
              <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => setResetIssued(null)} />
              <div className="if-admin-modal">
                <div className="border-b border-slate-200 px-5 py-4">
                  <p className="if-admin-muted text-xs font-bold uppercase tracking-[0.16em]">License</p>
                  <h2 className="if-admin-heading mt-1 text-2xl font-semibold">New key for {resetIssued.username}</h2>
                  <p className="if-admin-muted mt-2 text-sm">Copy it now. It is not stored in plain text after you close this.</p>
                </div>
                <div className="space-y-3 p-5">
                  <div className="if-admin-surface p-3 text-sm">
                    <p>
                      Username: <span className="font-semibold text-teal-800">{resetIssued.username}</span>
                    </p>
                    <p className="mt-1">
                      License key: <span className="font-semibold text-teal-800">{resetIssued.licenseKey}</span>
                    </p>
                    <p className="mt-1 break-all">
                      Bind PC: <span className="font-semibold text-teal-800">{bindLinkFor(resetIssued.username)}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="if-admin-btn if-admin-btn-ghost"
                      onClick={() => {
                        void navigator.clipboard.writeText(
                          `Username: ${resetIssued.username}\nLicense key: ${resetIssued.licenseKey}\nBind PC: ${bindLinkFor(resetIssued.username)}`,
                        );
                        toast.success('Copied username, license key, and bind link');
                      }}
                    >
                      <Copy className="h-4 w-4" />
                      Copy
                    </button>
                    <button
                      type="button"
                      className="if-admin-btn if-admin-btn-ghost"
                      onClick={() => {
                        void navigator.clipboard.writeText(
                          licenseConfigJson(resetIssued.username, resetIssued.licenseKey),
                        );
                        toast.success('Copied config.json');
                      }}
                    >
                      <Copy className="h-4 w-4" />
                      Copy config.json
                    </button>
                    <button type="button" className="if-admin-btn if-admin-btn-primary" onClick={() => setResetIssued(null)}>
                      Done
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
