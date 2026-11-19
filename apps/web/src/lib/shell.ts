import { isStaffRole } from '@/lib/roles';

/** Visual shells: created users + operator mailer share TUI; admin does not. */
export type AppShell = 'admin' | 'mailer' | 'auth';

export function shellFromPath(pathname: string): AppShell {
  if (pathname.startsWith('/admin')) return 'admin';
  if (
    pathname.startsWith('/bind-pc') ||
    pathname.startsWith('/bind-ip') ||
    pathname === '/activate' ||
    pathname === '/bind'
  ) {
    return 'admin';
  }
  if (pathname.startsWith('/app')) return 'mailer';
  return 'auth';
}

/** Browser tab titles. Control Panel is operator-only. */
export function documentTitle(pathname: string, role?: string | null): string {
  if (pathname.startsWith('/admin')) return 'Inbox Flow — Admin';
  if (
    pathname.startsWith('/bind-pc') ||
    pathname.startsWith('/bind-ip') ||
    pathname === '/activate' ||
    pathname === '/bind'
  ) {
    return 'Inbox Flow — Bind PC';
  }
  if (pathname.startsWith('/app')) {
    return isStaffRole(role) ? 'Inbox Flow — Control Panel' : 'Inbox Flow';
  }
  if (pathname.startsWith('/login')) return 'Inbox Flow — Sign in';
  return 'Inbox Flow';
}
