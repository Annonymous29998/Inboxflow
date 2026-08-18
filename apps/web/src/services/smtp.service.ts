import { api } from '@/lib/api';

export type SmtpProfile = {
  id: string;
  name: string;
  label?: string | null;
  type: string;
  isDefault: boolean;
  isActive: boolean;
  priority: number;
  dailyLimit?: number | null;
  hourlyLimit?: number | null;
  minuteLimit?: number | null;
  notes?: string | null;
  lastTestStatus?: string | null;
  lastTestError?: string | null;
  lastTestAt?: string | null;
  sentToday?: number;
  sentHour?: number;
  sentMinute?: number;
  successCount?: number;
  failCount?: number;
  successRate?: number;
  host?: string;
  port?: string;
  encryption?: string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  user?: string;
  hasPassword?: boolean;
  issues?: string[];
};

export const smtpService = {
  async list(): Promise<SmtpProfile[]> {
    const data = await api.get<{ providers: SmtpProfile[] }>('/api/providers');
    return data.providers.filter((p) => p.type === 'SMTP');
  },

  async get(id: string): Promise<SmtpProfile & { config?: Record<string, string> }> {
    return api.get<{ provider: SmtpProfile & { config?: Record<string, string> } }>(
      `/api/providers/${id}`,
    ).then((d) => d.provider);
  },

  async create(input: {
    name: string;
    label?: string | null;
    config: Record<string, string>;
    isDefault?: boolean;
    isActive?: boolean;
    dailyLimit?: number | null;
    hourlyLimit?: number | null;
    minuteLimit?: number | null;
    priority?: number;
    notes?: string | null;
  }): Promise<SmtpProfile> {
    // Prefer Railway for create — edge manage-smtp runs live SMTP verify and
    // Supabase blocks outbound 25/587 (connection timeout → 400).
    const data = await api.post<{ provider: SmtpProfile }>('/api/providers', {
      ...input,
      type: 'SMTP',
    });
    return data.provider;
  },

  async update(
    id: string,
    input: Partial<{
      name: string;
      label: string | null;
      config: Record<string, string>;
      isDefault: boolean;
      isActive: boolean;
      dailyLimit: number | null;
      hourlyLimit: number | null;
      minuteLimit: number | null;
      priority: number;
      notes: string | null;
    }>,
  ): Promise<SmtpProfile> {
    const data = await api.patch<{ provider: SmtpProfile }>(`/api/providers/${id}`, input);
    return data.provider;
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/api/providers/${id}`);
  },

  async testConnection(input: {
    providerId?: string;
    config?: Record<string, string>;
    sendTestEmail?: boolean;
    testEmailTo?: string;
    notes?: string | null;
    skipLiveVerify?: boolean;
  }): Promise<{
    success: boolean;
    message: string;
    error?: string;
    messageId?: string;
    issues?: string[];
    deliverabilityWarnings?: string[];
  }> {
    // Always use the Railway/API path for live SMTP verify/send.
    // Supabase Edge Functions block outbound ports 25 and 587
    // (https://supabase.com/docs/guides/functions/limits), which surfaces as
    // manage-smtp 400 + "Connection timeout".

    // Prefer id+config merge when editing so unsaved form fields are tested
    // and masked passwords can fall back to the stored secret.
    if (input.providerId) {
      const data = await api.post<{
        result: { success: boolean; message: string; error?: string; messageId?: string };
        issues?: string[];
        deliverabilityWarnings?: string[];
      }>(`/api/providers/${input.providerId}/test`, {
        sendTestEmail: Boolean(input.sendTestEmail),
        testEmailTo: input.testEmailTo,
        config: input.config,
        notes: input.notes || undefined,
        skipLiveVerify: Boolean(input.skipLiveVerify),
      });
      return { ...data.result, issues: data.issues || [], deliverabilityWarnings: data.deliverabilityWarnings || [] };
    }

    const data = await api.post<{
      result: { success: boolean; message: string; error?: string; messageId?: string };
      issues?: string[];
      deliverabilityWarnings?: string[];
    }>('/api/providers/test', {
      type: 'SMTP',
      config: input.config,
      sendTestEmail: Boolean(input.sendTestEmail),
      testEmailTo: input.testEmailTo,
      notes: input.notes || undefined,
      skipLiveVerify: Boolean(input.skipLiveVerify),
    });
    return { ...data.result, issues: data.issues || [], deliverabilityWarnings: data.deliverabilityWarnings || [] };
  },

  async detectTls(port: string | number) {
    return api.post<{
      port: number;
      encryption: 'SSL' | 'STARTTLS' | 'NONE';
      secure: boolean;
      hint?: string;
    }>('/api/providers/detect-tls', { port });
  },

  async exportProfiles() {
    return api.get<{ version: number; exportedAt: string; profiles: unknown[] }>(
      '/api/providers/export',
    );
  },

  async importProfiles(profiles: unknown[]) {
    return api.post<{ imported: number; note?: string }>('/api/providers/import', { profiles });
  },
};
