import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Mail,
  Globe,
  BarChart3,
  Settings,
  LogOut,
  Sparkles,
  Shield,
  FileText,
  Menu,
  X,
  Server,
  TerminalSquare,
  Command,
  Bell,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TerminalPanel } from '@/components/layout/TerminalPanel';
import { CommandPalette } from '@/components/layout/CommandPalette';

const LG = '(min-width: 1024px)';

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  key: string;
};

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: 'SEND',
    items: [
      { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true, key: '1' },
      { to: '/app/campaigns', label: 'Campaigns', icon: Mail, key: '2' },
      { to: '/app/templates', label: 'Templates', icon: FileText, key: '3' },
      { to: '/app/ai', label: 'AI Assistant', icon: Sparkles, key: '4' },
    ],
  },
  {
    label: 'AUDIENCE',
    items: [{ to: '/app/contacts', label: 'Contacts', icon: Users, key: '5' }],
  },
  {
    label: 'DELIVERABILITY',
    items: [
      { to: '/app/domains', label: 'Domains', icon: Globe, key: '6' },
      { to: '/app/analytics', label: 'Analytics', icon: BarChart3, key: '7' },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { to: '/app/smtp', label: 'SMTP Manager', icon: Server, key: 'S' },
      { to: '/app/settings', label: 'Settings', icon: Settings, key: '8' },
      { to: '/app/admin', label: 'Admin', icon: Shield, key: '9' },
    ],
  },
];

const flatNav = navGroups.flatMap((g) => g.items);

type NotifLog = {
  id: string;
  level: string;
  category: string;
  message: string;
  createdAt: string;
};

/**
 * Shell modeled after Nexlogs AdminLayout:
 * - Desktop: fixed sidebar (expanded or icon-collapsed) with hover name tooltips
 * - Main content pads to sidebar width and fills remaining space
 * - Mobile: overlay drawer + hamburger
 */
export function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(LG).matches : true,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotifLog[]>([]);
  const [hoverTip, setHoverTip] = useState<{ label: string; top: number } | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(LG);
    const onChange = () => {
      const desktop = mq.matches;
      setIsDesktop(desktop);
      if (desktop) setMobileOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!isDesktop && mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isDesktop, mobileOpen]);

  const loadNotifs = useCallback(async () => {
    try {
      const data = await api.get<{ logs: NotifLog[] }>('/api/logs?limit=12');
      setNotifs([...(data.logs || [])].reverse().slice(0, 12));
    } catch {
      /* ignore — panel still opens */
    }
  }, []);

  useEffect(() => {
    if (notifOpen) void loadNotifs();
  }, [notifOpen, loadNotifs]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (meta && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setTerminalOpen((v) => !v);
        return;
      }
      if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (window.matchMedia(LG).matches) setDesktopCollapsed((v) => !v);
        else setMobileOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (mobileOpen) setMobileOpen(false);
        if (notifOpen) setNotifOpen(false);
        setHoverTip(null);
        return;
      }

      // Number / letter shortcuts match sidebar keys when not typing
      if (!typing && !meta && !e.altKey) {
        const hit = flatNav.find((item) => item.key.toLowerCase() === e.key.toLowerCase());
        if (hit) {
          e.preventDefault();
          navigate(hit.to);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, notifOpen, navigate]);

  const tabTitle = useMemo(() => {
    const path = location.pathname;
    const match = flatNav.find((item) =>
      item.end ? path === item.to : path === item.to || path.startsWith(`${item.to}/`),
    );
    return match?.label || 'Dashboard';
  }, [location.pathname]);

  async function signOut() {
    await logout();
    navigate('/login');
  }

  function showTip(e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>, label: string) {
    if (!desktopCollapsed || !window.matchMedia(LG).matches) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverTip({ label, top: rect.top + rect.height / 2 });
  }

  function hideTip() {
    setHoverTip(null);
  }

  const sidebarVisible = isDesktop || mobileOpen;

  return (
    <div className="relative flex h-dvh max-h-dvh w-full max-w-full overflow-hidden bg-background font-mono text-foreground">
      <div className="nd-atmosphere" aria-hidden />

      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-card',
          'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          'transition-[width,transform] duration-200 ease-out',
          desktopCollapsed ? 'lg:w-16' : 'lg:w-64',
          'w-64',
          sidebarVisible ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div
          className={cn(
            'flex h-12 shrink-0 items-center border-b border-border',
            desktopCollapsed ? 'justify-center px-1' : 'justify-between gap-2 px-3',
          )}
        >
          <div className={cn('min-w-0', desktopCollapsed && 'lg:hidden')}>
            <p className="truncate text-xs font-bold tracking-widest text-primary">INBOX FLOW</p>
            <p className="truncate text-[10px] text-accent">inboxflow.io</p>
          </div>
          <button
            type="button"
            title={desktopCollapsed ? 'Expand menu' : 'Collapse menu'}
            aria-label={desktopCollapsed ? 'Expand menu' : 'Collapse menu'}
            className="hidden h-8 w-8 shrink-0 items-center justify-center border border-border text-muted-foreground hover:text-primary lg:inline-flex"
            onClick={() => {
              setDesktopCollapsed((v) => !v);
              setHoverTip(null);
            }}
            onMouseEnter={(e) => showTip(e, desktopCollapsed ? 'Expand menu' : 'Collapse menu')}
            onMouseLeave={hideTip}
          >
            {desktopCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
          <button
            type="button"
            title="Close menu"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-border text-muted-foreground hover:text-primary lg:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-2">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p
                className={cn(
                  'mb-1 px-2 text-[10px] uppercase tracking-wider text-accent',
                  desktopCollapsed && 'lg:hidden',
                )}
              >
                ── {group.label} ──
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    aria-label={item.label}
                    onMouseEnter={(e) => showTip(e, item.label)}
                    onMouseLeave={hideTip}
                    onFocus={(e) => showTip(e, item.label)}
                    onBlur={hideTip}
                    onClick={() => {
                      if (!window.matchMedia(LG).matches) setMobileOpen(false);
                      // Keep name visible briefly after click while collapsed
                      if (desktopCollapsed && window.matchMedia(LG).matches) {
                        setHoverTip((prev) =>
                          prev ? { ...prev, label: item.label } : { label: item.label, top: window.innerHeight / 2 },
                        );
                        window.setTimeout(() => setHoverTip(null), 900);
                      }
                    }}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-10 items-center gap-2 text-xs transition-colors sm:min-h-9',
                        desktopCollapsed ? 'lg:justify-center lg:px-0 lg:py-2.5' : 'px-2 py-2 sm:py-1.5',
                        isActive
                          ? 'nd-nav-active'
                          : 'text-muted-foreground hover:bg-muted hover:text-primary',
                      )
                    }
                  >
                    <span className={cn('w-4 shrink-0 text-accent', desktopCollapsed && 'lg:hidden')}>
                      [{item.key}]
                    </span>
                    <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                    <span className={cn('truncate', desktopCollapsed && 'lg:hidden')}>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div
          className={cn(
            'shrink-0 border-t border-border p-3',
            desktopCollapsed && 'lg:flex lg:flex-col lg:items-center lg:p-2',
          )}
        >
          <div className={cn('truncate text-xs', desktopCollapsed && 'lg:hidden')}>
            {user?.firstName} {user?.lastName}
          </div>
          <div className={cn('truncate text-[10px] text-muted-foreground', desktopCollapsed && 'lg:hidden')}>
            {user?.email}
          </div>
          <button
            type="button"
            aria-label="Sign out"
            onMouseEnter={(e) => showTip(e, 'Sign out')}
            onMouseLeave={hideTip}
            onClick={() => void signOut()}
            className={cn(
              'mt-2 flex min-h-10 w-full items-center justify-center gap-2 border border-border px-2 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary',
              desktopCollapsed && 'lg:mt-0 lg:h-9 lg:w-9 lg:min-h-0 lg:p-0',
            )}
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className={cn(desktopCollapsed && 'lg:hidden')}>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Collapsed icon name tooltip (Nexlogs-style) */}
      {hoverTip && desktopCollapsed ? (
        <div
          className="pointer-events-none fixed left-[4.5rem] z-[80] hidden -translate-y-1/2 items-center border border-border bg-card px-2.5 py-1.5 text-xs text-primary shadow-lg lg:flex"
          style={{ top: hoverTip.top }}
        >
          <span className="whitespace-nowrap">{hoverTip.label}</span>
        </div>
      ) : null}

      <div
        className={cn(
          'relative z-10 flex h-dvh min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-200',
          desktopCollapsed ? 'lg:pl-16' : 'lg:pl-64',
        )}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur sm:h-12 sm:px-4 lg:px-6">
          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-border text-primary lg:hidden"
            onClick={() => setMobileOpen(true)}
            title="Open menu"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="inline-block max-w-full truncate border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary">
              {tabTitle}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <button
              type="button"
              title="Notifications"
              aria-label="Notifications"
              onClick={() => {
                setNotifOpen((v) => !v);
                setTerminalOpen(false);
              }}
              className={cn(
                'relative inline-flex h-9 w-9 items-center justify-center border border-border text-muted-foreground hover:text-primary',
                notifOpen && 'border-primary/40 text-primary',
              )}
            >
              <Bell className="h-3.5 w-3.5" />
              {notifs.some((n) => n.level === 'ERROR' || n.level === 'WARNING') ? (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-destructive" />
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="inline-flex h-9 items-center gap-1 border border-border px-2 text-[10px] text-muted-foreground hover:text-primary"
            >
              <Command className="h-3 w-3" />
              <span className="hidden sm:inline">K</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTerminalOpen((v) => !v);
                setNotifOpen(false);
              }}
              className={cn(
                'inline-flex h-9 items-center gap-1 border border-border px-2 text-[10px] text-muted-foreground hover:text-primary',
                terminalOpen && 'border-primary/40 text-primary',
              )}
            >
              <TerminalSquare className="h-3 w-3" />
              <span className="hidden sm:inline">Terminal</span>
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="animate-fade-in w-full px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6">
            <Outlet />
          </div>
        </main>

        <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} />

        <footer className="tui-footer">
          <span className="hidden sm:inline">
            <span className="text-primary">⌘K</span> command
          </span>
          <span className="hidden text-muted-foreground sm:inline">·</span>
          <span>
            <span className="text-primary">⌘J</span> terminal
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            <span className="text-primary">⌘B</span> menu
          </span>
          <span className="ml-auto hidden truncate text-muted-foreground md:inline">
            Inbox Flow · {user?.email || 'session'}
          </span>
        </footer>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        extra={[
          {
            id: 'term',
            label: terminalOpen ? 'Hide terminal' : 'Show terminal',
            hint: '⌘J',
            run: () => setTerminalOpen((v) => !v),
          },
          {
            id: 'notifs',
            label: 'Open notifications',
            run: () => {
              setNotifOpen(true);
              void loadNotifs();
            },
          },
          {
            id: 'sidebar',
            label: isDesktop
              ? desktopCollapsed
                ? 'Expand sidebar'
                : 'Collapse sidebar'
              : mobileOpen
                ? 'Close menu'
                : 'Open menu',
            hint: '⌘B',
            run: () => {
              if (window.matchMedia(LG).matches) setDesktopCollapsed((v) => !v);
              else setMobileOpen((v) => !v);
            },
          },
        ]}
      />

      {notifOpen ? (
        <div className="absolute right-2 top-14 z-50 w-[min(20rem,calc(100vw-1rem))] border border-border bg-card shadow-xl sm:right-4 lg:right-6">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-accent">Notifications</div>
            <button
              type="button"
              className="text-[10px] text-primary hover:underline"
              onClick={() => {
                setNotifOpen(false);
                setTerminalOpen(true);
              }}
            >
              Open terminal
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto p-2 text-xs">
            {notifs.length ? (
              notifs.map((n) => (
                <div key={n.id} className="border-b border-border/50 px-1 py-2 last:border-0">
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span
                      className={cn(
                        n.level === 'ERROR' && 'text-destructive',
                        n.level === 'WARNING' && 'text-warning',
                        n.level === 'SUCCESS' && 'text-primary',
                        n.level === 'INFO' && 'text-accent',
                      )}
                    >
                      [{n.level}]
                    </span>
                    <span>[{n.category}]</span>
                    <span className="ml-auto">{new Date(n.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-0.5 break-words text-foreground">{n.message}</p>
                </div>
              ))
            ) : (
              <p className="px-2 py-4 text-muted-foreground">
                No recent events. SMTP / queue activity will appear here and in the terminal.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
