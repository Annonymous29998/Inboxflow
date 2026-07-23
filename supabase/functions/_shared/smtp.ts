import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseProviderConfig } from './crypto.ts';

export interface SmtpConfig {
  id: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  isDefault: boolean;
}

function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }
  return fallback;
}

/** SMTP profiles are added in the app (Settings → SMTP Manager) — no Supabase SMTP secrets. */
export async function resolveSmtpProvider(
  db: SupabaseClient,
  organizationId: string,
  providerId: string | null | undefined,
  encryptionKey: string,
): Promise<SmtpConfig> {
  const requested = providerId?.trim() || '';

  let query = db
    .from('EmailProvider')
    .select('id, name, type, isDefault, isActive, config, organizationId, priority')
    .eq('organizationId', organizationId)
    .eq('isActive', true)
    .eq('type', 'SMTP');

  if (requested && requested !== 'rotate' && requested !== 'auto') {
    query = query.eq('id', requested);
  } else {
    query = query.order('isDefault', { ascending: false }).order('priority', { ascending: false });
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      'No active SMTP profile configured. Add one in Settings → SMTP Manager and run Test Connection first.',
    );
  }

  const cfg = parseProviderConfig(data.config, encryptionKey);
  const port = Number(cfg.port || 587);
  const secure = toBool(cfg.secure, port === 465);

  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error('SMTP profile is incomplete. Edit it in SMTP Manager and save host, username, and password.');
  }

  return {
    id: data.id,
    host: String(cfg.host),
    port,
    secure,
    user: String(cfg.user),
    pass: String(cfg.pass),
    fromName: String(cfg.fromName || ''),
    fromEmail: String(cfg.fromEmail || cfg.user || ''),
    replyTo: cfg.replyTo ? String(cfg.replyTo) : undefined,
    isDefault: Boolean(data.isDefault),
  };
}

export async function sendViaSmtp(
  input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    headers?: Record<string, string>;
    fromEmail: string;
    fromName?: string;
    replyTo?: string;
  },
  smtp: SmtpConfig,
) {
  const nodemailer = await import('npm:nodemailer@6.9.16');
  const from = input.fromName?.trim()
    ? `"${input.fromName.replaceAll('"', '')}" <${input.fromEmail}>`
    : input.fromEmail;

  const attempts = smtp.isDefault
    ? [
        { port: smtp.port || 465, secure: smtp.secure !== false },
        { port: 465, secure: true },
        { port: 587, secure: false },
      ]
    : [{ port: smtp.port || 465, secure: smtp.secure !== false }];

  const seen = new Set<string>();
  const uniqueAttempts = attempts.filter((attempt) => {
    const key = `${attempt.port}:${attempt.secure}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastError: Error | null = null;

  for (const attempt of uniqueAttempts) {
    try {
      const transport = nodemailer.default.createTransport({
        host: smtp.host,
        port: attempt.port,
        secure: attempt.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
      });

      const messageId = await new Promise<string | undefined>((resolve, reject) => {
        transport.sendMail(
          {
            from,
            to: input.to,
            replyTo: input.replyTo,
            subject: input.subject,
            html: input.html,
            text: input.text,
            headers: input.headers,
          },
          (error: Error | null, info?: { messageId?: string }) => {
            if (error) reject(error);
            else resolve(info?.messageId);
          },
        );
      });

      return { messageId: messageId || `smtp-${Date.now()}` };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error('SMTP send failed');
}

export async function verifySmtpConnection(smtp: SmtpConfig): Promise<void> {
  const nodemailer = await import('npm:nodemailer@6.9.16');
  const transport = nodemailer.default.createTransport({
    host: smtp.host,
    port: smtp.port || 465,
    secure: smtp.secure !== false,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
  await transport.verify();
}
