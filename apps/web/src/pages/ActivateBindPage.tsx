import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { User } from '@/stores/auth';
import { mailerHomePath } from '@/lib/roles';
import { Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { loadDesktopLicenseConfig } from '@/lib/desktop-license-config';
import { useAuthStore } from '@/stores/auth';
import {
  DEMO_MAILER_IP,
  DEMO_MAILER_LICENSE,
  DEMO_MAILER_NAME,
  DEMO_MAILER_USER,
  DEMO_MAILER_WORKSPACE,
  MAILER_UI_DEMO,
  DEMO_MAILER_ID,
  clearDemoBound,
  demoMailerUser,
  isDemoMailerLogin,
  readDemoBound,
  writeDemoBound,
} from '@/lib/demo-mailer';

const LICENSE_MASK = '---- ---- ---- ----';

function formatValidUntil(iso: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function ActivateBindPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sessionUser = useAuthStore((s) => s.user);
  const acceptSession = useAuthStore((s) => s.acceptSession);
  const [username, setUsername] = useState(
    () => params.get('user') || (MAILER_UI_DEMO ? DEMO_MAILER_USER : ''),
  );
  const [licenseKey, setLicenseKey] = useState(() => (MAILER_UI_DEMO ? DEMO_MAILER_LICENSE : ''));
  const [rdpIp, setRdpIp] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [validUntil, setValidUntil] = useState('');
  const [boundIp, setBoundIp] = useState('');
  const [bindOpen, setBindOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const setUser = useAuthStore((s) => s.setUser);

  useEffect(() => {
    void loadDesktopLicenseConfig().then((cfg) => {
      if (!cfg) return;
      if (cfg.username) setUsername((prev) => prev || cfg.username || '');
      if (cfg.license_key) setLicenseKey((prev) => prev || cfg.license_key || '');
    });
  }, []);

  useEffect(() => {
    const reset = params.get('reset') === '1';
    if (MAILER_UI_DEMO && reset) {
      clearDemoBound();
      setValidUntil('');
      setBoundIp('');
      setDoneOpen(false);
      if (sessionUser?.id === DEMO_MAILER_ID) setUser({ ...sessionUser, boundIp: null });
      return;
    }
    const stored = readDemoBound();
    const ip = stored?.boundIp || sessionUser?.boundIp || '';
    if (!ip) return;
    setBoundIp(ip);
    if (stored?.validUntil) setValidUntil(stored.validUntil);
    if (sessionUser && sessionUser.boundIp !== ip) setUser({ ...sessionUser, boundIp: ip });
  }, []);

  const displayName =
    username.trim().toLowerCase() === DEMO_MAILER_USER
      ? DEMO_MAILER_NAME
      : username.trim() || sessionUser?.firstName || '—';
  const workspace =
    username.trim().toLowerCase() === DEMO_MAILER_USER
      ? DEMO_MAILER_WORKSPACE
      : sessionUser?.organization?.name || `${displayName} workspace`;
  const activated = Boolean(boundIp);
  const pcIp = boundIp || '—';

  function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (MAILER_UI_DEMO && username.trim().toLowerCase() === DEMO_MAILER_USER && !isDemoMailerLogin(username, licenseKey)) {
      setError('Wrong username or license key');
      return;
    }
    if (!username.trim() || !licenseKey.trim()) {
      setError('Enter username and license key');
      return;
    }
    setUnlocked(true);
  }

  async function onBind(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!licenseKey.trim() || !rdpIp.trim()) {
      setError('Enter your license key and IP address');
      return;
    }
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rdpIp.trim()) && !rdpIp.includes(':')) {
      setError('Enter a valid IP address');
      return;
    }
    setLoading(true);
    try {
      if (isDemoMailerLogin(username, licenseKey) || (MAILER_UI_DEMO && username.trim().toLowerCase() === DEMO_MAILER_USER)) {
        const until = new Date(Date.now() + 30 * 86400000).toISOString();
        const ip = rdpIp.trim() || DEMO_MAILER_IP;
        writeDemoBound(ip, until);
        window.inboxflowDesktop?.saveBoundIp?.(ip);
        setBoundIp(ip);
        setValidUntil(until);
        setBindOpen(false);
        setDoneOpen(true);
        if (sessionUser) setUser({ ...sessionUser, boundIp: ip });
        else setUser(demoMailerUser(ip));
        return;
      }
      const result = await api.post<{
        username: string;
        boundIp: string;
        validUntil: string;
        accessToken?: string;
        refreshToken?: string;
        user?: User;
      }>('/api/auth/bind-ip', { username, licenseKey, boundIp: rdpIp.trim() }, { timeoutMs: 20_000 });
      window.inboxflowDesktop?.saveBoundIp?.(result.boundIp);
      try {
        await api.post('/api/workspace/device-bind', { boundIp: result.boundIp }, { timeoutMs: 8_000 });
      } catch {
        /* EXE local stamp is optional if they are not signed in yet */
      }
      setBoundIp(result.boundIp);
      setValidUntil(result.validUntil);
      setBindOpen(false);
      setDoneOpen(true);
      if (result.accessToken && result.user) {
        acceptSession({
          user: { ...result.user, boundIp: result.boundIp },
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        });
      } else if (sessionUser) {
        setUser({ ...sessionUser, boundIp: result.boundIp });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not bind this PC');
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setUnlocked(false);
    setError('');
    setBindOpen(false);
    setDoneOpen(false);
  }

  if (!unlocked) {
    return (
      <div className="if-admin-root relative flex min-h-dvh items-center justify-center overflow-y-auto px-4 py-10">
        <div className="relative z-10 w-full max-w-md">
          <div className="mb-6 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-teal-600 text-sm font-extrabold text-white shadow-[0_8px_20px_rgba(13,148,136,0.28)]">
              IF
            </div>
            <p className="mt-3 text-xs font-bold uppercase tracking-[0.2em] text-teal-700">Inbox Flow</p>
            <h1 className="if-admin-heading mt-2 text-3xl font-semibold">Bind PC</h1>
            <p className="if-admin-lede mt-2 text-sm">Enter your username and license key</p>
          </div>
          <form className="if-admin-card space-y-4 p-6" onSubmit={onUnlock}>
            <label className="block">
              <span className="if-admin-muted text-xs font-bold uppercase tracking-wide">Username</span>
              <input
                id="bind-user"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none ring-teal-600 focus:ring-2"
              />
            </label>
            <label className="block">
              <span className="if-admin-muted text-xs font-bold uppercase tracking-wide">License key</span>
              <div className="relative mt-1.5">
                <input
                  id="bind-license"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 pr-10 text-sm text-slate-900 outline-none ring-teal-600 focus:ring-2"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Hide license key' : 'Show license key'}
                  className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400 hover:text-teal-700"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}
            <button type="submit" className="if-admin-btn if-admin-btn-primary w-full justify-center">
              Continue
            </button>
          </form>
        </div>
      </div>
    );
  }

  const details = [
    { label: 'Name', value: displayName },
    { label: 'Workspace', value: workspace },
    { label: 'License', value: activated ? `Valid until ${formatValidUntil(validUntil)}` : LICENSE_MASK },
    { label: 'IP address', value: pcIp },
    { label: 'PC lock', value: activated ? 'Activated' : 'Not bound' },
  ];

  return (
    <div className="if-admin-root relative min-h-dvh overflow-y-auto">
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="if-admin-page">
          <div className="if-admin-hero">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700">Inbox Flow</p>
              <h1 className="if-admin-heading if-admin-title mt-1 font-semibold">Dashboard overview</h1>
              <p className="if-admin-lede mt-2 max-w-2xl text-sm leading-relaxed">
                {activated
                  ? `License valid until ${formatValidUntil(validUntil)}. You can open the mailer.`
                  : 'License not activated. Bind PC to activate this license, then the mailer can work.'}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
              <button type="button" onClick={logout} className="if-admin-btn if-admin-btn-ghost">
                Log out
              </button>
              {activated ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-center text-xs font-bold uppercase tracking-wide text-emerald-700">
                  Activated
                </span>
              ) : (
                <span className="rounded-full bg-amber-100 px-3 py-1 text-center text-xs font-bold uppercase tracking-wide text-amber-800">
                  Not bound
                </span>
              )}
            </div>
          </div>

          <section className="if-admin-card overflow-hidden p-0">
            <div className="flex flex-col gap-5 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:p-7">
              <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-teal-600 text-2xl font-extrabold text-white shadow-[0_8px_20px_rgba(13,148,136,0.28)]">
                {displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="if-admin-muted text-xs font-bold uppercase tracking-wide">Workspace</p>
                <h2 className="if-admin-heading mt-1 break-words text-2xl font-semibold sm:text-3xl">{workspace}</h2>
                <p className="mt-1 break-words text-sm font-semibold text-slate-700">{displayName}</p>
              </div>
            </div>

            <div className="p-5 sm:p-7">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="if-admin-heading text-lg font-semibold">Profile</h3>
                  <p className="if-admin-muted mt-1 text-sm">
                    {activated
                      ? `Valid until ${formatValidUntil(validUntil)}`
                      : 'License not activated. You need to Bind PC to activate this license.'}
                  </p>
                </div>
                {activated ? (
                  <Link
                    to={mailerHomePath(sessionUser?.role)}
                    className="if-admin-btn if-admin-btn-primary justify-center sm:min-w-[10rem]"
                  >
                    Open mailer
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setBindOpen(true);
                    }}
                    className="if-admin-btn if-admin-btn-primary justify-center sm:min-w-[10rem]"
                  >
                    Bind PC
                  </button>
                )}
              </div>
              <dl className="mt-5 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {details.map((row) => (
                  <div
                    key={row.label}
                    className="grid gap-1 px-4 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-start sm:gap-6 sm:px-5"
                  >
                    <dt className="if-admin-muted text-xs font-bold uppercase tracking-wide">{row.label}</dt>
                    <dd className="break-words text-base font-semibold leading-snug text-slate-900 sm:text-lg">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </div>
      </div>

      {bindOpen ? (
        <div className="if-admin-modal-overlay">
          <form className="if-admin-modal p-6" onSubmit={onBind}>
            <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Bind PC</p>
            <h2 className="if-admin-heading mt-2 text-2xl font-semibold">Activate this license</h2>
            <p className="if-admin-muted mt-2 text-sm">Enter your license key and IP address.</p>
            <label className="mt-5 block">
              <span className="if-admin-field">License key</span>
              <input
                type={showKey ? 'text' : 'password'}
                required
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                className="if-admin-input"
              />
            </label>
            <label className="mt-3 block">
              <span className="if-admin-field">IP address</span>
              <input
                required
                inputMode="decimal"
                placeholder="e.g. 203.0.113.40"
                value={rdpIp}
                onChange={(e) => setRdpIp(e.target.value)}
                className="if-admin-input"
              />
            </label>
            {error ? <p className="mt-3 text-sm font-medium text-rose-600">{error}</p> : null}
            <div className="mt-6 flex gap-2">
              <button type="button" className="if-admin-btn if-admin-btn-ghost flex-1" onClick={() => setBindOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={loading} className="if-admin-btn if-admin-btn-primary flex-1">
                {loading ? 'Binding…' : 'Bind PC'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {doneOpen ? (
        <div className="if-admin-modal-overlay">
          <div className="if-admin-modal p-6">
            <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Activated</p>
            <h2 className="if-admin-heading mt-2 text-2xl font-semibold">This PC is bound</h2>
            <p className="if-admin-lede mt-3 text-sm font-semibold text-slate-800">
              You can now use the mailer.
            </p>
            <div className="mt-4 space-y-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
              <p>
                <span className="if-admin-muted mr-2 text-xs font-bold uppercase tracking-wide">License</span>
                <span className="break-all font-semibold text-slate-900">{licenseKey.trim() || LICENSE_MASK}</span>
              </p>
              <p>
                <span className="if-admin-muted mr-2 text-xs font-bold uppercase tracking-wide">Valid until</span>
                <span className="font-semibold text-slate-900">{formatValidUntil(validUntil)}</span>
              </p>
              <p>
                <span className="if-admin-muted mr-2 text-xs font-bold uppercase tracking-wide">IP address</span>
                <span className="break-all font-semibold text-slate-900">{pcIp}</span>
              </p>
            </div>
            <button
              type="button"
              className="if-admin-btn if-admin-btn-primary mt-6 w-full justify-center"
              onClick={() => {
                setDoneOpen(false);
                navigate(mailerHomePath(sessionUser?.role));
              }}
            >
              Continue
            </button>
            <button type="button" className="if-admin-btn if-admin-btn-ghost mt-2 w-full justify-center" onClick={() => setDoneOpen(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
