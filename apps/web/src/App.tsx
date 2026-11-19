import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useLayoutEffect, useRef } from 'react';
import '@/styles/admin-web.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '@/pages/AuthPages';
import { DashboardPage } from '@/pages/DashboardPage';
import { ContactsPage } from '@/pages/ContactsPage';
import { CampaignsPage, CampaignEditorPage } from '@/pages/CampaignsPage';
import { DomainsPage } from '@/pages/DomainsPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { AiPage, SettingsPage, TemplatesPage } from '@/pages/OtherPages';
import { AdminBoot } from '@/pages/admin/AdminBoot';
import { AdminDashboardPage } from '@/pages/admin/AdminDashboardPage';
import { AdminUsersPage } from '@/pages/admin/AdminUsersPage';
import { AdminActiveUsersPage } from '@/pages/admin/AdminActiveUsersPage';
import { AdminActivityPage } from '@/pages/admin/AdminActivityPage';
import { AdminHealthPage } from '@/pages/admin/AdminHealthPage';
import { SmtpManagerPage } from '@/pages/SmtpManagerPage';
import { QueueConsolePage } from '@/pages/QueueConsolePage';
import { useAuthStore } from '@/stores/auth';
import { Toaster } from '@/components/ui/Toaster';
import { ConfirmViewport } from '@/components/ui/ConfirmViewport';
import { isMailerTenant, isStaffRole, tenantNeedsBind } from '@/lib/roles';
import { documentTitle, shellFromPath } from '@/lib/shell';
import { useToastStore } from '@/stores/toast';
import { useConfirmStore } from '@/stores/confirm';
import { AppErrorBoundary } from '@/components/layout/AppErrorBoundary';
import { ActivateBindPage } from '@/pages/ActivateBindPage';
import { BindRequiredModal } from '@/components/auth/BindRequiredModal';

const queryClient = new QueryClient();

function Protected({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const fetchMe = useAuthStore((s) => s.fetchMe);

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  if (!user) return <Navigate to="/login" replace />;
  if (tenantNeedsBind(user)) {
    return (
      <div className="min-h-dvh bg-background">
        <BindRequiredModal open username={user.firstName || user.email || ''} />
      </div>
    );
  }
  return <>{children}</>;
}

function MailerHome() {
  const role = useAuthStore((s) => s.user?.role);
  if (isMailerTenant(role)) return <Navigate to="/app/campaigns" replace />;
  return <DashboardPage />;
}

function StaffOnly({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  if (!isStaffRole(role)) return <Navigate to="/app/campaigns" replace />;
  return <>{children}</>;
}

/** Keep TUI mailer, light admin, and auth from sharing html/body theme. */
function ShellTheme() {
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.user?.role);
  useLayoutEffect(() => {
    const html = document.documentElement;
    const shell = shellFromPath(pathname);
    html.dataset.shell = shell;
    document.body.dataset.shell = shell;
    html.classList.toggle('dark', shell !== 'admin');
    html.style.colorScheme = shell === 'admin' ? 'light' : 'dark';
    document.title = documentTitle(pathname, role);
  }, [pathname, role]);
  return null;
}

/** Drop overlays + query cache when the account or product shell changes. */
function SessionFence() {
  const { pathname } = useLocation();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const prevUser = useRef(userId);
  const prevShell = useRef(shellFromPath(pathname));

  useEffect(() => {
    if (prevUser.current && prevUser.current !== userId) {
      queryClient.clear();
      useToastStore.getState().clear();
      useConfirmStore.getState().closeConfirm(false);
      useConfirmStore.getState().closePrompt(null);
    }
    prevUser.current = userId;
  }, [userId]);

  useEffect(() => {
    const shell = shellFromPath(pathname);
    if (prevShell.current !== shell) {
      useToastStore.getState().clear();
      useConfirmStore.getState().closeConfirm(false);
      useConfirmStore.getState().closePrompt(null);
    }
    prevShell.current = shell;
  }, [pathname]);

  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ShellTheme />
        <SessionFence />
        <AppErrorBoundary>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/bind-pc" element={<ActivateBindPage />} />
          <Route path="/bind-ip" element={<Navigate to="/bind-pc" replace />} />
          <Route path="/activate" element={<Navigate to="/bind-pc" replace />} />
          <Route path="/bind" element={<Navigate to="/bind-pc" replace />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route
            path="/app"
            element={
              <Protected>
                <AppLayout />
              </Protected>
            }
          >
            <Route index element={<MailerHome />} />
            <Route path="contacts" element={<ContactsPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
            <Route path="campaigns/:id" element={<CampaignEditorPage />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route
              path="domains"
              element={
                <StaffOnly>
                  <DomainsPage />
                </StaffOnly>
              }
            />
            <Route
              path="analytics"
              element={
                <StaffOnly>
                  <AnalyticsPage />
                </StaffOnly>
              }
            />
            <Route
              path="ai"
              element={
                <StaffOnly>
                  <AiPage />
                </StaffOnly>
              }
            />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/smtp" element={<Navigate to="/app/smtp" replace />} />
            <Route path="smtp" element={<SmtpManagerPage />} />
            <Route path="queue" element={<QueueConsolePage />} />
            <Route path="admin" element={<Navigate to="/admin" replace />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Route>
          <Route
            path="/admin"
            element={
              <Protected>
                <StaffOnly>
                  <AdminBoot />
                </StaffOnly>
              </Protected>
            }
          >
            <Route index element={<AdminDashboardPage />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="users/active" element={<AdminActiveUsersPage />} />
            <Route path="health" element={<AdminHealthPage />} />
            <Route path="health/sends" element={<AdminHealthPage />} />
            <Route path="health/data" element={<AdminHealthPage />} />
            <Route path="activity" element={<AdminActivityPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        </AppErrorBoundary>
        <Toaster />
        <ConfirmViewport />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
