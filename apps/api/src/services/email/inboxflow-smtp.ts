import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { decrypt } from '../../utils/crypto.js';
import { emailDomain } from './mail-headers.js';
import { filterDeliverableAddresses } from './recipient-guard.js';

export const INBOXFLOW_SMTP_HOSTNAME = (
  process.env.INBOXFLOW_SMTP_HOSTNAME || 'smtp.inboxflow.io'
).trim();
export const INBOXFLOW_SMTP_LISTEN_PORT = Number(process.env.INBOXFLOW_SMTP_LISTEN_PORT || 2525);
export const INBOXFLOW_SMTP_LISTEN_HOST = (process.env.INBOXFLOW_SMTP_LISTEN_HOST || '127.0.0.1').trim() || '127.0.0.1';
export const INBOXFLOW_SMTP_DAILY_LIMIT = Number(process.env.INBOXFLOW_SMTP_DAILY_LIMIT || 1000);

function smtpListenIsLoopback() {
  return INBOXFLOW_SMTP_LISTEN_HOST === '127.0.0.1' || INBOXFLOW_SMTP_LISTEN_HOST === '::1';
}

type AuthUser = {
  credentialId: string;
  domainId: string;
  domain: string;
  organizationId: string;
};

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

export function isInboxFlowSmtpHost(host: string | undefined): boolean {
  const h = String(host || '')
    .trim()
    .toLowerCase();
  return Boolean(h) && h === INBOXFLOW_SMTP_HOSTNAME.toLowerCase();
}

function parseStoredConfig(config: unknown): Record<string, string> {
  if (typeof config === 'string') {
    try {
      return JSON.parse(decrypt(config));
    } catch {
      return JSON.parse(config);
    }
  }
  if (config && typeof config === 'object' && 'encrypted' in config) {
    return JSON.parse(decrypt((config as { encrypted: string }).encrypted));
  }
  return (config || {}) as Record<string, string>;
}

function envRelayReady(): boolean {
  const host = String(env.SMTP_HOST || '').trim();
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) return false;
  if (['json', 'dev', 'console'].includes(host.toLowerCase())) return false;
  if (isInboxFlowSmtpHost(host)) return false;
  return true;
}

async function resolveRelayTransport(organizationId: string) {
  if (envRelayReady()) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 120000,
    });
  }

  const providers = await prisma.emailProvider.findMany({
    where: { organizationId, isActive: true, type: 'SMTP' },
    orderBy: [{ isDefault: 'desc' }, { priority: 'desc' }],
  });
  for (const p of providers) {
    const cfg = parseStoredConfig(p.config);
    const host = String(cfg.host || '').trim();
    if (!host || isInboxFlowSmtpHost(host) || cfg.viaApiKey === 'true') continue;
    if (['json', 'dev', 'console'].includes(host.toLowerCase())) continue;
    const port = Number(cfg.port || 587);
    const enc = String(cfg.encryption || '').toUpperCase();
    const secure = enc === 'SSL' || enc === 'TLS' || cfg.secure === 'true' || port === 465;
    return nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && enc !== 'NONE',
      ignoreTLS: cfg.ignoreTLS === 'true' || enc === 'NONE',
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass || '' } : undefined,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 120000,
      tls: { rejectUnauthorized: cfg.ignoreTLS !== 'true', servername: host },
    });
  }
  throw new Error(
    'Inbox Flow SMTP has no relay. Activate a normal SMTP in SMTP Manager (Brevo, SES, …) first.',
  );
}

async function loadCredential(username: string) {
  const row = await prisma.domainSmtpCredential.findUnique({
    where: { username },
    include: { domain: true },
  });
  return row;
}

async function bumpSent(id: string, sentToday: number, sentDay: string) {
  const today = utcDay();
  const next = sentDay === today ? sentToday + 1 : 1;
  await prisma.domainSmtpCredential.update({
    where: { id },
    data: { sentToday: next, sentDay: today, lastUsedAt: new Date() },
  });
}

export function startInboxFlowSmtpServer(): Promise<void> {
  const server = new SMTPServer({
    name: INBOXFLOW_SMTP_HOSTNAME,
    banner: 'Inbox Flow SMTP',
    authOptional: false,
    allowInsecureAuth: smtpListenIsLoopback(),
    disabledCommands: ['STARTTLS'],
    size: 15 * 1024 * 1024,
    onAuth: (
      auth: SMTPServerAuthentication,
      _session: SMTPServerSession,
      callback: (err: Error | null | undefined, response?: { user?: AuthUser }) => void,
    ) => {
      void (async () => {
        try {
          const username = String(auth.username || '').trim();
          const password = String(auth.password || '');
          const row = await loadCredential(username);
          if (!row?.isActive || row.domain.status !== 'VERIFIED') {
            callback(new Error('Invalid login'));
            return;
          }
          const ok = await bcrypt.compare(password, row.passwordHash);
          if (!ok) {
            callback(new Error('Invalid login'));
            return;
          }
          const today = utcDay();
          const used = row.sentDay === today ? row.sentToday : 0;
          if (used >= row.dailyLimit) {
            callback(new Error(`Daily limit reached (${row.dailyLimit})`));
            return;
          }
          const user: AuthUser = {
            credentialId: row.id,
            domainId: row.domainId,
            domain: row.domain.domain,
            organizationId: row.organizationId,
          };
          callback(null, { user });
        } catch (err) {
          callback(err instanceof Error ? err : new Error('Auth failed'));
        }
      })();
    },
    onMailFrom: (
      address: { address?: string },
      session: SMTPServerSession,
      callback: (err?: Error | null) => void,
    ) => {
      const user = session.user as AuthUser | undefined;
      const fromDom = emailDomain(address.address || '');
      if (!user || !fromDom || (fromDom !== user.domain && !fromDom.endsWith(`.${user.domain}`))) {
        callback(new Error(`From address must be on ${user?.domain || 'the verified domain'}`));
        return;
      }
      callback();
    },
    onData: (
      stream: NodeJS.ReadableStream,
      session: SMTPServerSession,
      callback: (err?: Error | null) => void,
    ) => {
      void (async () => {
        try {
          const user = session.user as AuthUser | undefined;
          if (!user) {
            callback(new Error('Not authenticated'));
            return;
          }
          const row = await prisma.domainSmtpCredential.findUnique({
            where: { id: user.credentialId },
          });
          if (!row?.isActive) {
            callback(new Error('Credential revoked'));
            return;
          }
          const today = utcDay();
          const used = row.sentDay === today ? row.sentToday : 0;
          if (used >= row.dailyLimit) {
            callback(new Error(`Daily limit reached (${row.dailyLimit})`));
            return;
          }
          const parsed = await simpleParser(stream);
          const envelopeFrom =
            session.envelope.mailFrom && typeof session.envelope.mailFrom === 'object'
              ? session.envelope.mailFrom.address
              : '';
          const from = parsed.from?.value?.[0]?.address || envelopeFrom || '';
          const to = [
            ...(parsed.to?.value || []).map((a) => a.address).filter(Boolean),
            ...session.envelope.rcptTo.map((r: { address: string }) => r.address),
          ].filter(Boolean) as string[];
          const uniqueTo = [...new Set(to)];
          if (!from || !uniqueTo.length) {
            callback(new Error('Missing From or To'));
            return;
          }
          const { deliverable } = await filterDeliverableAddresses(uniqueTo);
          if (!deliverable.length) {
            callback(new Error('No deliverable recipients (invalid address or domain has no MX)'));
            return;
          }
          const transport = await resolveRelayTransport(user.organizationId);
          await transport.sendMail({
            from: parsed.from?.text || from,
            to: deliverable,
            subject: parsed.subject || '',
            html: parsed.html || undefined,
            text: parsed.text || undefined,
            replyTo: parsed.replyTo?.text || undefined,
          });
          await bumpSent(row.id, used, row.sentDay);
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error('Relay failed'));
        }
      })();
    },
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      console.error('[inboxflow-smtp]', err);
    });
    server.listen(INBOXFLOW_SMTP_LISTEN_PORT, INBOXFLOW_SMTP_LISTEN_HOST, () => {
      console.log(
        `Inbox Flow SMTP ${INBOXFLOW_SMTP_HOSTNAME} listening on ${INBOXFLOW_SMTP_LISTEN_HOST}:${INBOXFLOW_SMTP_LISTEN_PORT}`,
      );
      resolve();
    });
  });
}
