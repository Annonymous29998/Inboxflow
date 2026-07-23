import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useEffect } from 'react';
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
import { AdminPage, AiPage, SettingsPage, TemplatesPage } from '@/pages/OtherPages';
import { SmtpManagerPage } from '@/pages/SmtpManagerPage';
import { useAuthStore } from '@/stores/auth';

const queryClient = new QueryClient();

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading, fetchMe } = useAuthStore();

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  if (loading) {
    return (
      <div className="relative flex h-full min-h-screen items-center justify-center overflow-y-auto bg-background font-mono text-muted-foreground">
        <div className="nd-atmosphere" aria-hidden />
        <p className="relative text-sm">
          <span className="text-primary">$</span> loading workspace…
        </p>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
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
            <Route index element={<DashboardPage />} />
            <Route path="contacts" element={<ContactsPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
            <Route path="campaigns/:id" element={<CampaignEditorPage />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route path="domains" element={<DomainsPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="ai" element={<AiPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="smtp" element={<SmtpManagerPage />} />
            <Route path="admin" element={<AdminPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
