import { useEffect, useMemo, useState, type FocusEvent, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Activity, ChevronDown, ChevronLeft, ChevronRight, HeartPulse, LayoutDashboard, LogOut, Mail, Menu, Users, X } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import '@/styles/admin-web.css';

type NavChild = { to: string; label: string; end?: boolean };

const USER_SUBNAV: NavChild[] = [
  { to: '/admin/users', label: 'All Users', end: true },
  { to: '/admin/users/active', label: 'Active Users' },
];

const NAV = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: Users, children: USER_SUBNAV },
  { to: '/admin/health', label: 'Health', icon: HeartPulse },
  { to: '/admin/activity', label: 'Activity', icon: Activity },
];

/** Same breakpoint as the operator mailer shell. */
const DESKTOP = '(min-width: 1024px)';

export function AdminLayout() {
  const { user, logout } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hoverTip, setHoverTip] = useState<{ label: string; top: number } | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const path = typeof window !== 'undefined' ? window.location.pathname : '';
    return {
      Users: path.startsWith('/admin/users'),
    };
  });
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(DESKTOP).matches : false,
  );

  const title = useMemo(() => {
    for (const item of NAV) {
      const sub = item.children?.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
      if (sub) return sub.label;
    }
    const hit = NAV.find((n) => !n.children && (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
    return hit?.label || 'Dashboard';
  }, [location.pathname]);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = () => {
      setIsDesktop(mq.matches);
      if (mq.matches) setMenuOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    if (location.pathname.startsWith('/admin/users')) {
      setOpenGroups((cur) => ({ ...cur, Users: true }));
    }
  }, [location.pathname]);

  useEffect(() => {
    if (isDesktop || !menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, isDesktop]);

  async function signOut() {
    await logout();
    navigate('/login');
  }

  function exitAdmin() {
    navigate('/app');
  }

  const initial = (user?.firstName || user?.email || 'A').slice(0, 1).toUpperCase();
  const sideOpen = isDesktop || menuOpen;
  const rail = isDesktop && collapsed;

  function showTip(e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>, label: string) {
    if (!rail) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverTip({ label, top: rect.top + rect.height / 2 });
  }

  function hideTip() {
    setHoverTip(null);
  }

  return (
    <div
      className="if-admin-root flex h-dvh max-h-dvh w-full min-w-0 overflow-hidden"
      data-collapsed={rail ? 'true' : 'false'}
    >
      {!isDesktop && menuOpen ? (
        <button
          type="button"
          aria-label="Close admin menu"
          className="fixed inset-0 z-40 bg-slate-900/30 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'if-admin-side fixed inset-y-0 left-0 z-50 flex flex-col px-3 py-4',
          'transition-transform duration-200 ease-out',
          sideOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        aria-hidden={!sideOpen}
      >
        <div className={cn('mb-3 flex items-center gap-2 px-1', rail ? 'justify-center' : 'justify-between')}>
          <span className={cn('text-[11px] font-bold uppercase tracking-[0.16em] text-slate-600', rail && 'hidden')}>
            Admin Panel
          </span>
          <button
            type="button"
            className="hidden h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-900 lg:grid"
            title={collapsed ? 'Open menu' : 'Close menu'}
            aria-label={collapsed ? 'Open menu' : 'Close menu'}
            onMouseEnter={(e) => showTip(e, collapsed ? 'Open menu' : 'Close menu')}
            onMouseLeave={hideTip}
            onClick={() => {
              setCollapsed((v) => !v);
              hideTip();
            }}
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-full border border-slate-200 text-slate-500 lg:hidden"
            onClick={() => setMenuOpen(false)}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className={cn('mb-4 flex items-start gap-3 px-1', rail && 'justify-center')}>
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#3dff3d] text-sm font-extrabold text-[#050805] shadow-[0_8px_20px_rgba(61,255,61,0.28)]">
            IF
          </div>
          <div className={cn('min-w-0', rail && 'hidden')}>
            <p className="text-[1.05rem] font-extrabold leading-tight text-slate-900">
              Inbox.<span className="text-teal-600">Flow</span>
            </p>
            <p className="mt-1 text-xs leading-snug text-slate-600">Dashboard management and operator controls</p>
          </div>
        </div>

        <p className={cn('mb-1 px-2 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600', rail && 'hidden')}>
          Overview
        </p>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {NAV.map((item) => {
            const nested = Boolean(item.children?.length);
            const groupOpen = Boolean(openGroups[item.label]);
            const groupOn = nested && location.pathname.startsWith(item.to);
            const leafOn = item.end
              ? location.pathname === item.to
              : !nested && location.pathname.startsWith(item.to);
            if (nested) {
              return (
                <div key={item.label}>
                  <button
                    type="button"
                    aria-expanded={groupOpen}
                    aria-label={`${item.label} menu`}
                    onMouseEnter={(e) => showTip(e, item.label)}
                    onMouseLeave={hideTip}
                    onClick={() => {
                      if (rail) {
                        setCollapsed(false);
                        setOpenGroups((cur) => ({ ...cur, [item.label]: true }));
                        return;
                      }
                      setOpenGroups((cur) => ({ ...cur, [item.label]: !cur[item.label] }));
                    }}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-[0.9rem] font-semibold',
                      rail && 'justify-center px-0',
                      groupOn ? 'bg-[#0f766e] text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                    )}
                  >
                    <item.icon className="h-[1.05rem] w-[1.05rem] shrink-0" />
                    <span className={cn('min-w-0 flex-1 truncate text-left', rail && 'hidden')}>{item.label}</span>
                    {!rail ? (
                      <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', groupOpen && 'rotate-180')} />
                    ) : null}
                  </button>
                  {groupOpen && !rail
                    ? item.children!.map((child) => (
                        <NavLink
                          key={child.to}
                          to={child.to}
                          end={child.end}
                          onClick={() => setMenuOpen(false)}
                          className={({ isActive }) =>
                            cn(
                              'ml-4 mt-1 flex min-h-10 items-center rounded-xl px-3 text-[0.82rem] font-semibold',
                              isActive ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                            )
                          }
                        >
                          {child.label}
                        </NavLink>
                      ))
                    : null}
                </div>
              );
            }
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                aria-label={item.label}
                onMouseEnter={(e) => showTip(e, item.label)}
                onMouseLeave={hideTip}
                onFocus={(e) => showTip(e, item.label)}
                onBlur={hideTip}
                onClick={() => setMenuOpen(false)}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-xl px-3 text-[0.9rem] font-semibold',
                  rail && 'justify-center px-0',
                  leafOn ? 'bg-[#0f766e] text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                <item.icon className="h-[1.05rem] w-[1.05rem] shrink-0" />
                <span className={cn(rail && 'hidden')}>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="mt-auto grid gap-2 border-t border-slate-200 pt-3">
          <div className={cn('flex min-w-0 items-center gap-2.5 px-1', rail && 'justify-center')}>
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-teal-700 text-sm font-bold text-[#3dff3d]">
              {initial}
            </div>
            <div className={cn('min-w-0', rail && 'hidden')}>
              <p className="truncate text-sm font-semibold text-slate-900">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="truncate text-xs text-slate-600">{user?.email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={exitAdmin}
            title="Back to mailer"
            onMouseEnter={(e) => showTip(e, 'Back to mailer')}
            onMouseLeave={hideTip}
            className={cn(
              'inline-flex min-h-10 items-center gap-2 rounded-xl px-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100 hover:text-teal-700',
              rail && 'justify-center px-0',
            )}
          >
            <Mail className="h-4 w-4 shrink-0" />
            <span className={cn(rail && 'hidden')}>Back to mailer</span>
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            title="Sign out"
            onMouseEnter={(e) => showTip(e, 'Sign out')}
            onMouseLeave={hideTip}
            className={cn(
              'inline-flex min-h-10 items-center gap-2 rounded-xl px-2.5 text-sm font-bold text-slate-600 hover:bg-rose-50 hover:text-rose-600',
              rail && 'justify-center px-0',
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className={cn(rail && 'hidden')}>Sign out</span>
          </button>
        </div>
      </aside>

      {hoverTip && rail ? (
        <div className="if-admin-tip" style={{ top: hoverTip.top }}>
          {hoverTip.label}
        </div>
      ) : null}

      <div className="if-admin-shell">
        <header className="flex h-12 shrink-0 items-center gap-3 px-4 sm:h-12 lg:px-6">
          <button
            type="button"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-slate-300 bg-slate-100 text-slate-800 lg:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open sidebar"
          >
            <Menu className="h-4 w-4" />
          </button>
          <h2 className="if-admin-heading min-w-0 truncate text-[1.05rem] font-extrabold">
            {title === 'Dashboard' ? 'Admin Dashboard' : title}
          </h2>
        </header>
        <main className="if-admin-stage min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 lg:px-6 lg:py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
