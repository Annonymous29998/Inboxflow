import { api } from '@/lib/api';
import { edgeFunctionsEnabled } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/lib/invoke-edge';

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

type EdgeAccount = Record<string, unknown>;

function mapEdgeAccount(row: EdgeAccount): SmtpProfile {
  return {
    id: String(row.id),
    name: String(row.name || row.label || 'SMTP'),
    label: row.label ? String(row.label) : null,
    type: 'SMTP',
    isDefault: Boolean(row.isDefault),
    isActive: Boolean(row.isActive),
    priority: Number(row.priority ?? 0),
    dailyLimit: row.dailyLimit != null ? Number(row.dailyLimit) : null,
    hourlyLimit: row.hourlyLimit != null ? Number(row.hourlyLimit) : null,
    notes: row.notes ? String(row.notes) : null,
    lastTestStatus: row.lastTestStatus ? String(row.lastTestStatus) : 'Pending',
    lastTestError: row.lastTestError ? String(row.lastTestError) : null,
    lastTestAt: row.lastTestAt ? String(row.lastTestAt) : null,
    host: row.host ? String(row.host) : undefined,
    port: row.port != null ? String(row.port) : undefined,
    encryption: row.encryption ? String(row.encryption) : undefined,
    fromEmail: row.fromEmail ? String(row.fromEmail) : undefined,
    fromName: row.fromName ? String(row.fromName) : undefined,
    replyTo: row.replyTo ? String(row.replyTo) : undefined,
    user: row.user ? String(row.user) : undefined,
    hasPassword: Boolean(row.hasPassword),
  };
}

export const smtpService = {
  async list(): Promise<SmtpProfile[]> {
    try {
      if (edgeFunctionsEnabled) {
        const data = await invokeEdgeFunction<{ ok: boolean; accounts: EdgeAccount[] }>('manage-smtp', {
          action: 'list',
        });
        return (data.accounts ?? []).map(mapEdgeAccount);
      }
    } catch {
      // Fall through — edge functions unreachable (Railway / no deploy)
    }

    const data = await api.get<{ providers: SmtpProfile[] }>('/api/providers');
    return data.providers.filter((p) => p.type === 'SMTP');
  },

  async get(id: string): Promise<SmtpProfile & { config?: Record<string, string> }> {
    try {
      if (edgeFunctionsEnabled) {
        const accounts = await smtpService.list();
        const found = accounts.find((a) => a.id === id);
        if (found) {
          return {
            ...found,
            config: {
              host: found.host || '',
              port: found.port || '587',
              encryption: found.encryption || 'STARTTLS',
              user: found.user || '',
              pass: '••••••••',
              fromEmail: found.fromEmail || '',
              fromName: found.fromName || '',
              replyTo: found.replyTo || '',
            },
          };
        }
      }
    } catch {
      // Fall through — edge functions unreachable
    }

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
    try {
      if (edgeFunctionsEnabled) {
        await invokeEdgeFunction('manage-smtp', { action: 'delete', id });
        return;
      }
    } catch {
      // Fall through — edge functions unreachable
    }
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
