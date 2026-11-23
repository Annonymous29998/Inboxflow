import nodemailer from 'nodemailer';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { decrypt } from '../../utils/crypto.js';
import type { ProviderType } from '@prisma/client';
import {
  buildMessageId,
  explainSmtpSendFailure,
  formatFromHeader,
  parseSmtpFromIdentities,
  resolveSmtpFromEmail,
} from './mail-headers.js';
import {
  INBOXFLOW_SMTP_LISTEN_PORT,
  isInboxFlowSmtpHost,
} from './inboxflow-smtp.js';
import { guardRecipientAddress } from './recipient-guard.js';
import { assertOutboundPathAllowed, smtpBindLocalAddress, smtpSocksProxyUrl } from './smtp-outbound.js';
import * as socks from 'socks';

function htmlToPlainText(html: string) {
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SendEmailPayload {
  to: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  messageId?: string;
  /** Optional app-side DKIM (nodemailer). Prefer provider-signed mail when available. */
  dkim?: {
    domainName: string;
    keySelector: string;
    privateKey: string;
  };
  /** Org domains with SPF+DKIM+DMARC verified — any local-part @ these may be From. */
  authorizedFromDomains?: string[];
  attachments?: Array<{ filename: string; contentType?: string; content: Buffer | string; encoding?: string }>;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  provider: ProviderType;
  /** SMTP 250 line (or API id). Empty means we did not get an MTA accept. */
  smtpResponse?: string;
}

function isMockSmtpHost(host: string) {
  const h = String(host || '').trim().toLowerCase();
  return h === 'json' || h === 'dev' || h === 'console';
}

function allowMockSmtp() {
  return process.env.NODE_ENV === 'test' || process.env.INBOXFLOW_ALLOW_JSON_SMTP === '1';
}

type SmtpInfoLike = {
  messageId?: string;
  response?: string;
  accepted?: unknown;
  rejected?: unknown;
  pending?: unknown;
};

function smtpAcceptedRecipient(info: SmtpInfoLike, to: string): { ok: boolean; error?: string; response?: string } {
  const toAddr = String(to || '').trim().toLowerCase();
  const response = String(info.response || '').trim();
  const accepted = Array.isArray(info.accepted)
    ? info.accepted.map((x) => String(x || '').toLowerCase()).filter(Boolean)
    : [];
  const rejected = Array.isArray(info.rejected)
    ? info.rejected.map((x) => String(x || '').toLowerCase()).filter(Boolean)
    : [];
  const pending = Array.isArray(info.pending)
    ? info.pending.map((x) => String(x || '').toLowerCase()).filter(Boolean)
    : [];

  if (rejected.length && (!toAddr || rejected.some((r) => r.includes(toAddr) || toAddr.includes(r)))) {
    return { ok: false, error: `SMTP rejected recipient: ${rejected.join(', ')}`, response };
  }
  if (pending.length && (!accepted.length || (toAddr && pending.some((p) => p.includes(toAddr))))) {
    return { ok: false, error: `SMTP deferred recipient (not delivered): ${pending.join(', ')}`, response };
  }
  const acceptedTo = !toAddr || accepted.some((a) => a.includes(toAddr) || toAddr.includes(a));
  const twoXx = /^2\d\d\b/.test(response);
  if (accepted.length && acceptedTo) {
    return { ok: true, response: response || `accepted ${accepted.join(', ')}` };
  }
  if (!accepted.length && twoXx) {
    return { ok: true, response };
  }
  if (!accepted.length && !response) {
    return {
      ok: false,
      error: 'SMTP did not accept the message (no 250 response). Mail was not handed to the server.',
      response,
    };
  }
  return {
    ok: false,
    error: `SMTP did not accept ${to || 'recipient'}${response ? `: ${response}` : ''}`,
    response,
  };
}

type ProviderConfig = Record<string, string>;

export function parseProviderConfig(config: unknown): ProviderConfig {
  if (typeof config === 'string') {
    try {
      return JSON.parse(decrypt(config));
    } catch {
      return JSON.parse(config);
    }
  }
  if (config && typeof config === 'object' && 'encrypted' in config) {
    const enc = (config as { encrypted: string }).encrypted;
    return JSON.parse(decrypt(enc));
  }
  return config as ProviderConfig;
}

/** @deprecated use parseProviderConfig */
function parseConfig(config: unknown): ProviderConfig {
  return parseProviderConfig(config);
}

export type SmtpTestInput = {
  host?: string;
  port?: number | string;
  secure?: boolean | string;
  user?: string;
  pass?: string;
  requireTLS?: boolean | string;
  ignoreTLS?: boolean | string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  [key: string]: string | number | boolean | undefined;
};

export type ConnectionTestResult = {
  success: boolean;
  message: string;
  details?: {
    host: string;
    port: number;
    secure: boolean;
    authenticated: boolean;
    responseTimeMs: number;
  };
  error?: string;
  messageId?: string;
  sentCount?: number;
  fromEmails?: string[];
};

function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1' || value === 'yes';
  return fallback;
}

/**
 * Kestrel-style: honor the SMTP profile Encryption field exactly.
 * SSL/TLS = implicit TLS on connect (SMTP_SSL). STARTTLS = upgrade after EHLO.
 * None = plain TCP, no STARTTLS. "Allow insecure TLS" only skips cert checks.
 */
export function smtpOptionsFromProfile(config: SmtpTestInput | ProviderConfig) {
  const host = String(config.host || '').trim();
  const encryption = String((config as SmtpTestInput).encryption || '').toUpperCase();
  const port = Number(
    config.port || (encryption === 'SSL' || encryption === 'TLS' ? 465 : 587),
  );
  const allowInsecureCert = toBool((config as SmtpTestInput).ignoreTLS, false);
  const user = config.user ? String(config.user) : '';
  const pass = config.pass ? String(config.pass) : '';

  let secure = false;
  let requireTLS = false;
  let disableStartTls = false;

  if (encryption === 'SSL' || encryption === 'TLS') {
    secure = true;
    requireTLS = false;
    disableStartTls = false;
  } else if (encryption === 'NONE') {
    secure = false;
    requireTLS = false;
    disableStartTls = true;
  } else if (encryption === 'STARTTLS') {
    secure = false;
    requireTLS = true;
    disableStartTls = false;
  } else {
    secure = toBool((config as SmtpTestInput).secure, port === 465);
    requireTLS = toBool((config as SmtpTestInput).requireTLS, !secure);
    disableStartTls = !secure && !requireTLS;
  }

  if (isInboxFlowSmtpHost(host)) {
    return {
      host: '127.0.0.1',
      port: INBOXFLOW_SMTP_LISTEN_PORT,
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
      allowInsecureCert: true,
      user,
      pass,
      encryption: 'NONE',
    };
  }

  return {
    host,
    port,
    secure,
    requireTLS: disableStartTls ? false : requireTLS,
    ignoreTLS: disableStartTls,
    allowInsecureCert,
    user,
    pass,
    encryption: encryption || (secure ? 'SSL' : requireTLS ? 'STARTTLS' : 'NONE'),
  };
}

function bindAddressMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRNOTAVAIL/i.test(message);
}

export function createSmtpTransport(
  config: SmtpTestInput | ProviderConfig,
  timeouts?: {
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
    allowDirect?: boolean;
    /** Public Bind PC address is often NAT, not an address on the network card. */
    skipLocalBind?: boolean;
  },
) {
  const host = String(config.host || '').trim();
  if (!host) {
    throw new Error('SMTP host is required');
  }

  if (host === 'json' || host === 'dev' || host === 'console') {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  const opts = smtpOptionsFromProfile(config);
  const flat = Object.fromEntries(
    Object.entries(config as Record<string, unknown>).map(([k, v]) => [k, v == null ? '' : String(v)]),
  ) as Record<string, string>;
  if (timeouts?.allowDirect === false) {
    assertOutboundPathAllowed(flat, false);
  }
  const loopback = opts.host === '127.0.0.1' || opts.host === 'localhost';
  const localAddress = loopback || timeouts?.skipLocalBind ? undefined : smtpBindLocalAddress(flat);
  const proxy = loopback ? undefined : smtpSocksProxyUrl(flat);

  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    requireTLS: opts.requireTLS,
    ignoreTLS: opts.ignoreTLS,
    auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    ...(localAddress ? { localAddress } : {}),
    ...(proxy ? { proxy } : {}),
    connectionTimeout: timeouts?.connectionTimeout ?? 20000,
    greetingTimeout: timeouts?.greetingTimeout ?? 20000,
    socketTimeout: timeouts?.socketTimeout ?? 120000,
    tls: {
      rejectUnauthorized: !opts.allowInsecureCert,
      servername: opts.host,
      ...(opts.allowInsecureCert || opts.ignoreTLS
        ? { minVersion: 'TLSv1' as const, ciphers: 'DEFAULT:@SECLEVEL=0' }
        : {}),
    },
  });
  if (proxy) {
    transport.set?.('proxy_socks_module', socks);
  }
  return transport;
}

/**
 * Verify SMTP credentials/connectivity with nodemailer.verify().
 * Does not send an email.
 */
export async function testSmtpConnection(
  config: SmtpTestInput,
  opts?: { allowDirect?: boolean },
): Promise<ConnectionTestResult> {
  const started = Date.now();
  const host = String(config.host || '').trim();
  const port = Number(config.port || 587);
  const secure = toBool(config.secure, port === 465);

  async function verifyOnce(cfg: SmtpTestInput, skipLocalBind = false): Promise<ConnectionTestResult> {
    const p = Number(cfg.port || 587);
    const s = toBool(cfg.secure, p === 465);
    try {
      const transport = createSmtpTransport(cfg, { allowDirect: opts?.allowDirect, skipLocalBind });
      await transport.verify();
      transport.close?.();
      return {
        success: true,
        message: `Connected to ${host}:${p} successfully`,
        details: {
          host,
          port: p,
          secure: s,
          authenticated: Boolean(cfg.user),
          responseTimeMs: Date.now() - started,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SMTP connection failed';
      if (!skipLocalBind && bindAddressMissing(error)) {
        return verifyOnce(cfg, true);
      }
      return {
        success: false,
        message: 'SMTP connection failed',
        error: message,
        details: {
          host,
          port: p,
          secure: s,
          authenticated: Boolean(cfg.user),
          responseTimeMs: Date.now() - started,
        },
      };
    }
  }

  try {
    if (!host) {
      return { success: false, message: 'SMTP host is required', error: 'Missing host' };
    }

    const primary = await verifyOnce(config);
    if (primary.success) return primary;

    // Cloud hosts often block 587; many relays (Bulko, Mailgun, etc.) expose 2525.
    const err = (primary.error || '').toLowerCase();
    const looksLikeTimeout =
      err.includes('timeout') || err.includes('timed out') || err.includes('etimedout') || err.includes('econnrefused');
    if (looksLikeTimeout && port === 587 && !secure) {
      const fallback = await verifyOnce({
        ...config,
        port: 2525,
        secure: false,
        requireTLS: true,
      });
      if (fallback.success) {
        return {
          ...fallback,
          message: `Connected to ${host}:2525 successfully (587 was blocked; use port 2525)`,
        };
      }
    }

    return primary;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SMTP connection failed';
    return {
      success: false,
      message: 'SMTP connection failed',
      error: message,
      details: {
        host,
        port,
        secure,
        authenticated: Boolean(config.user),
        responseTimeMs: Date.now() - started,
      },
    };
  }
}

/**
 * Optionally send a real test email after verify().
 * From display: sender name if set, otherwise bare from-email (never a hardcoded brand).
 * Body: optional notes, otherwise a short connection confirmation.
 */
export async function sendSmtpTestEmail(
  config: SmtpTestInput,
  to: string,
  options?: { notes?: string | null; allowDirect?: boolean },
): Promise<ConnectionTestResult & { messageId?: string }> {
  const verify = await testSmtpConnection(config, { allowDirect: options?.allowDirect });
  if (!verify.success) return verify;

  const host = String(config.host || '').trim();
  if (isMockSmtpHost(host) && !allowMockSmtp()) {
    return {
      success: false,
      message: 'SMTP is in mock mode (host json/dev/console) — no email was delivered',
      error: 'Configure a real SMTP host before sending',
      details: verify.details,
    };
  }

  const identities = parseSmtpFromIdentities(config as Record<string, string>);
  const froms = identities.length
    ? identities
    : [
        {
          email: String(config.fromEmail || config.user || '').trim() || 'noreply@localhost',
          name: String(config.fromName || '').trim(),
        },
      ];
  const notes = String(options?.notes || '').trim();
  const bodyText = notes || 'Your SMTP connection is working.';
  const bodyHtml = notes
    ? `<p>${notes.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p>`
    : '<p>Your SMTP connection is working.</p>';

  const sentFrom: string[] = [];
  const errors: string[] = [];
  let lastMessageId: string | undefined;
  let skipLocalBind = false;
  let transport = createSmtpTransport(config, { allowDirect: options?.allowDirect });

  for (let i = 0; i < froms.length; i++) {
    const ident = froms[i]!;
    const fromEmail = ident.email;
    const fromName = ident.name || String(config.fromName || '').trim();
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    try {
      const messageId = buildMessageId(fromEmail);
      let info;
      try {
        info = await transport.sendMail({
          from: formatFromHeader(fromEmail, fromName),
          to,
          replyTo: config.replyTo || undefined,
          subject: froms.length > 1 ? `SMTP connection test (${i + 1}/${froms.length})` : 'SMTP connection test',
          text: bodyText,
          html: bodyHtml,
          messageId,
          date: new Date(),
          envelope: { from: fromEmail, to },
        });
      } catch (sendError) {
        if (!skipLocalBind && bindAddressMissing(sendError)) {
          transport.close?.();
          skipLocalBind = true;
          transport = createSmtpTransport(config, { allowDirect: options?.allowDirect, skipLocalBind: true });
          info = await transport.sendMail({
            from: formatFromHeader(fromEmail, fromName),
            to,
            replyTo: config.replyTo || undefined,
            subject: froms.length > 1 ? `SMTP connection test (${i + 1}/${froms.length})` : 'SMTP connection test',
            text: bodyText,
            html: bodyHtml,
            messageId,
            date: new Date(),
            envelope: { from: fromEmail, to },
          });
        } else {
          throw sendError;
        }
      }
      const accept = smtpAcceptedRecipient(info as SmtpInfoLike, to);
      if (!accept.ok && !isMockSmtpHost(host)) {
        errors.push(`${fromEmail}: ${accept.error || 'not accepted'}`);
        continue;
      }
      sentFrom.push(fromEmail);
      lastMessageId = info.messageId;
    } catch (error) {
      errors.push(`${fromEmail}: ${error instanceof Error ? error.message : 'Send failed'}`);
    }
  }

  if (!sentFrom.length) {
    return {
      success: false,
      message: 'SMTP verified but sending test email failed',
      error: errors.join(' · ') || 'Send failed',
      details: verify.details,
      sentCount: 0,
      fromEmails: [],
    };
  }

  return {
    ...verify,
    success: errors.length === 0,
    message: `Connected and sent ${sentFrom.length} test email${sentFrom.length === 1 ? '' : 's'} to ${to} from ${sentFrom.join(', ')}`,
    messageId: lastMessageId,
    sentCount: sentFrom.length,
    fromEmails: sentFrom,
    error: errors.length ? errors.join(' · ') : undefined,
  };
}

export async function testProviderConnection(
  type: ProviderType,
  rawConfig: unknown,
  opts?: { allowDirect?: boolean },
): Promise<ConnectionTestResult> {
  // Accept both: (a) raw Prisma config { encrypted: '...' } store object and (b) already-decoded flat Record<string,string>.
  // (Avoids double-decode crash when /:id/test passes already-parsed config.)
  let config: Record<string, string>;
  try {
    config = parseProviderConfig(rawConfig);
  } catch {
    config = Object.fromEntries(
      Object.entries((rawConfig ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
    );
  }
  if (type === 'SMTP') {
    return testSmtpConnection(config, { allowDirect: opts?.allowDirect });
  }

  // Lightweight credential presence checks for API providers
  const required: Record<string, string[]> = {
    SES: ['accessKeyId', 'secretAccessKey'],
    SENDGRID: ['apiKey'],
    MAILGUN: ['apiKey', 'domain'],
    POSTMARK: ['serverToken'],
  };
  const missing = (required[type] || []).filter((k) => !config[k]);
  if (missing.length) {
    return {
      success: false,
      message: `${type} configuration incomplete`,
      error: `Missing: ${missing.join(', ')}`,
    };
  }
  return {
    success: true,
    message: `${type} credentials look complete. Use a campaign send to fully validate delivery.`,
  };
}

export async function sendViaProvider(
  type: ProviderType,
  rawConfig: unknown,
  payload: SendEmailPayload,
  options: { portFailover?: boolean; allowDirect?: boolean } = {},
): Promise<SendResult> {
  const config = parseConfig(rawConfig);

  const recipientGuard = await guardRecipientAddress(payload.to);
  if (!recipientGuard.ok) {
    return { success: false, error: recipientGuard.reason, provider: type };
  }

  try {
    switch (type) {
      case 'SMTP':
        return await sendSmtp(config, payload, {
          portFailover: options.portFailover,
          allowDirect: options.allowDirect,
        });
      case 'SES':
        return await sendSes(config, payload);
      case 'SENDGRID':
        return await sendSendgrid(config, payload);
      case 'MAILGUN':
        return await sendMailgun(config, payload);
      case 'POSTMARK':
        return await sendPostmark(config, payload);
      default:
        return { success: false, error: `Unsupported provider: ${type}`, provider: type };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Send failed',
      provider: type,
    };
  }
}

export type SmtpSendOptions = {
  /** When true (default SMTP / Hostinger-style), try 465 ↔ 587 failover. */
  portFailover?: boolean;
  allowDirect?: boolean;
};

async function sendSmtp(
  config: ProviderConfig,
  payload: SendEmailPayload,
  options: SmtpSendOptions = {},
): Promise<SendResult> {
  const host = config.host || 'localhost';
  const resolved = resolveSmtpFromEmail(payload.from, config, {
    authorizedDomains: payload.authorizedFromDomains,
  });
  const fromEmail = resolved.from || 'noreply@localhost';
  const from = formatFromHeader(fromEmail, payload.fromName || config.fromName);
  const text = (payload.text && payload.text.trim()) || htmlToPlainText(payload.html || '');
  const messageId = payload.messageId || buildMessageId(fromEmail);
  const mail = {
    from,
    to: payload.to,
    replyTo: payload.replyTo,
    subject: payload.subject,
    html: payload.html,
    text,
    headers: payload.headers,
    messageId,
    date: new Date(),
    envelope: { from: fromEmail, to: payload.to },
    ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
    ...(payload.dkim
      ? {
          dkim: {
            domainName: payload.dkim.domainName,
            keySelector: payload.dkim.keySelector,
            privateKey: payload.dkim.privateKey,
          },
        }
      : {}),
  };

  if (isMockSmtpHost(host)) {
    if (!allowMockSmtp()) {
      return {
        success: false,
        error: 'SMTP host is json/dev/console — messages are not delivered. Set a real SMTP host.',
        provider: 'SMTP',
      };
    }
    const transport = createSmtpTransport(config, { allowDirect: options.allowDirect });
    const info = await transport.sendMail(mail);
    console.log('[dev-send]', payload.to, payload.subject);
    return { success: true, messageId: info.messageId || messageId, provider: 'SMTP', smtpResponse: 'mock' };
  }

  const profile = smtpOptionsFromProfile(config);
  const attempts: Array<SmtpTestInput | ProviderConfig> = [{ ...config }];

  // Default Hostinger-style only: try the other common port after a connection failure.
  // Never rewrite Encryption=None (Kestrel sends plain if the profile says None).
  if (options.portFailover && profile.encryption !== 'NONE') {
    if (profile.port !== 465) {
      attempts.push({ ...config, port: '465', encryption: 'SSL', secure: 'true', requireTLS: 'false' });
    }
    if (profile.port !== 587) {
      attempts.push({
        ...config,
        port: '587',
        encryption: 'STARTTLS',
        secure: 'false',
        requireTLS: 'true',
      });
    }
  }

  const isTransient = (msg: string) =>
    /write unknown|econnreset|epipe|socket hang up|econnaborted|etimedout|greeting never received/i.test(
      msg,
    );

  let lastError = 'SMTP send failed';
  for (let i = 0; i < attempts.length; i += 1) {
    const attemptCfg = attempts[i]!;
    let skipLocalBind = false;
    for (let tryN = 0; tryN < 3; tryN += 1) {
      const transport = createSmtpTransport(attemptCfg, {
        socketTimeout: 120000,
        allowDirect: options.allowDirect,
        skipLocalBind,
      });
      try {
        const info = await transport.sendMail(mail);
        transport.close?.();
        const accept = smtpAcceptedRecipient(info as SmtpInfoLike, payload.to);
        if (!accept.ok) {
          return {
            success: false,
            error: accept.error || 'SMTP did not accept the recipient',
            provider: 'SMTP',
            messageId: info.messageId || messageId,
            smtpResponse: accept.response,
          };
        }
        return {
          success: true,
          messageId: info.messageId || messageId,
          provider: 'SMTP',
          smtpResponse: accept.response,
        };
      } catch (error) {
        transport.close?.();
        const raw = error instanceof Error ? error.message : 'SMTP send failed';
        lastError = explainSmtpSendFailure(raw);
        if (!skipLocalBind && bindAddressMissing(error)) {
          skipLocalBind = true;
          continue;
        }
        if (tryN === 0 && isTransient(raw)) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        break;
      }
    }
  }

  return { success: false, error: lastError, provider: 'SMTP', smtpResponse: lastError };
}

/** Send via SMTP with optional 465↔587 failover (for default/Hostinger accounts). */
export async function sendViaSmtpWithFailover(
  rawConfig: unknown,
  payload: SendEmailPayload,
  portFailover = false,
): Promise<SendResult> {
  const config = parseProviderConfig(rawConfig);
  return sendSmtp(config, payload, { portFailover });
}

async function sendSes(config: ProviderConfig, payload: SendEmailPayload): Promise<SendResult> {
  const client = new SESClient({
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const result = await client.send(
    new SendEmailCommand({
      Source: payload.fromName ? `${payload.fromName} <${payload.from}>` : payload.from,
      Destination: { ToAddresses: [payload.to] },
      ReplyToAddresses: payload.replyTo ? [payload.replyTo] : undefined,
      Message: {
        Subject: { Data: payload.subject },
        Body: {
          Html: { Data: payload.html },
          ...(payload.text ? { Text: { Data: payload.text } } : {}),
        },
      },
    }),
  );

  return { success: true, messageId: result.MessageId, provider: 'SES' };
}

async function sendSendgrid(config: ProviderConfig, payload: SendEmailPayload): Promise<SendResult> {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: payload.to }] }],
      from: { email: payload.from, name: payload.fromName },
      reply_to: payload.replyTo ? { email: payload.replyTo } : undefined,
      subject: payload.subject,
      content: [
        ...(payload.text ? [{ type: 'text/plain', value: payload.text }] : []),
        { type: 'text/html', value: payload.html },
      ],
      headers: payload.headers,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: text, provider: 'SENDGRID' };
  }

  return {
    success: true,
    messageId: res.headers.get('x-message-id') || undefined,
    provider: 'SENDGRID',
  };
}

async function sendMailgun(config: ProviderConfig, payload: SendEmailPayload): Promise<SendResult> {
  const domain = config.domain;
  const form = new FormData();
  form.append('from', payload.fromName ? `${payload.fromName} <${payload.from}>` : payload.from);
  form.append('to', payload.to);
  form.append('subject', payload.subject);
  form.append('html', payload.html);
  if (payload.text) form.append('text', payload.text);
  if (payload.replyTo) form.append('h:Reply-To', payload.replyTo);

  const region = config.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
  const res = await fetch(`https://${region}/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
    },
    body: form,
  });

  const data = (await res.json()) as { id?: string; message?: string };
  if (!res.ok) {
    return { success: false, error: data.message || 'Mailgun error', provider: 'MAILGUN' };
  }
  return { success: true, messageId: data.id, provider: 'MAILGUN' };
}

async function sendPostmark(config: ProviderConfig, payload: SendEmailPayload): Promise<SendResult> {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': config.serverToken,
    },
    body: JSON.stringify({
      From: payload.fromName ? `${payload.fromName} <${payload.from}>` : payload.from,
      To: payload.to,
      ReplyTo: payload.replyTo,
      Subject: payload.subject,
      HtmlBody: payload.html,
      TextBody: payload.text,
      Headers: payload.headers
        ? Object.entries(payload.headers).map(([Name, Value]) => ({ Name, Value }))
        : undefined,
      TrackOpens: true,
    }),
  });

  const data = (await res.json()) as { MessageID?: string; Message?: string };
  if (!res.ok) {
    return { success: false, error: data.Message || 'Postmark error', provider: 'POSTMARK' };
  }
  return { success: true, messageId: data.MessageID, provider: 'POSTMARK' };
}
