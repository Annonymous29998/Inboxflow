import { api } from '@/lib/api';

export type SmtpFromIdentity = { email: string; name?: string };

/** API may send an array or a JSON string (config blob / demo workspace). */
export function parseFromIdentities(raw: unknown): SmtpFromIdentity[] {
  if (Array.isArray(raw)) {
    return raw
      .map((row) => {
        if (typeof row === 'string') return { email: row.trim(), name: '' };
        if (row && typeof row === 'object') {
          const r = row as { email?: unknown; name?: unknown };
          return { email: String(r.email || '').trim(), name: String(r.name || '').trim() };
        }
        return { email: '', name: '' };
      })
      .filter((s) => s.email);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return parseFromIdentities(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

/** Profile title that was filled from the sender list, not typed as a custom name. */
export function isGeneratedSenderName(value: string | null | undefined): boolean {
  const parts = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => /^[^\s,<>]+@[^\s,<>]+\.[^\s,<>]+$/.test(part));
}

export function senderListLabel(emails: string[]): string {
  return emails.map((email) => email.trim()).filter(Boolean).join(', ');
}

function normalizeProfile<T extends SmtpProfile>(p: T): T {
  return { ...p, fromIdentities: parseFromIdentities(p.fromIdentities) };
}

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
  fromIdentities?: SmtpFromIdentity[];
  replyTo?: string;
  user?: string;
  outboundPath?: string;
  bindIp?: string;
  socksHost?: string;
  socksPort?: string;
  socksUser?: string;
  hasSocksPass?: boolean;
  viaApiKey?: boolean;
  hasPassword?: boolean;
  issues?: string[];
};

export const smtpService = {
  async list(): Promise<SmtpProfile[]> {
    const data = await api.get<{ providers: SmtpProfile[] }>('/api/providers');
    return Array.isArray(data.providers) ? data.providers.map(normalizeProfile) : [];
  },

  async listSmtp(): Promise<SmtpProfile[]> {
    return (await this.list()).filter((p) => p.type === 'SMTP' && !p.viaApiKey);
  },

  async get(id: string): Promise<SmtpProfile & { config?: Record<string, string> }> {
    return api.get<{ provider: SmtpProfile & { config?: Record<string, string> } }>(
      `/api/providers/${id}`,
    ).then((d) => (d.provider ? normalizeProfile(d.provider) : d.provider));
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
    sentCount?: number;
    fromEmails?: string[];
    issues?: string[];
  }> {
    // Always use the Railway/API path for live SMTP verify/send.
    // Supabase Edge Functions block outbound ports 25 and 587
    // (https://supabase.com/docs/guides/functions/limits), which surfaces as
    // manage-smtp 400 + "Connection timeout".

    // Prefer id+config merge when editing so unsaved form fields are tested
    // and masked passwords can fall back to the stored secret.
    if (input.providerId) {
      const data = await api.post<{
        result: {
          success: boolean;
          message: string;
          error?: string;
          messageId?: string;
          sentCount?: number;
          fromEmails?: string[];
        };
        issues?: string[];
        deliverabilityWarnings?: string[];
      }>(`/api/providers/${input.providerId}/test`, {
        sendTestEmail: Boolean(input.sendTestEmail),
        testEmailTo: input.testEmailTo,
        config: input.config,
        notes: input.notes || undefined,
        skipLiveVerify: Boolean(input.skipLiveVerify),
      });
      return { ...data.result, issues: data.issues || [] };
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
    return { ...data.result, issues: data.issues || [] };
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
