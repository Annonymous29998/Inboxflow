import nodemailer from 'nodemailer';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { decrypt } from '../../utils/crypto.js';
import type { ProviderType } from '@prisma/client';

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
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  provider: ProviderType;
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
};

function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1' || value === 'yes';
  return fallback;
}

export function createSmtpTransport(config: SmtpTestInput | ProviderConfig) {
  const host = String(config.host || '').trim();
  if (!host) {
    throw new Error('SMTP host is required');
  }

  if (host === 'json' || host === 'dev' || host === 'console') {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  const port = Number(config.port || 587);
  const secure = toBool(config.secure, port === 465);
  const user = config.user ? String(config.user) : '';
  const pass = config.pass ? String(config.pass) : '';

  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: toBool((config as SmtpTestInput).requireTLS, !secure && port === 587),
    ignoreTLS: toBool((config as SmtpTestInput).ignoreTLS, false),
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: {
      // Allow self-signed only when explicitly requested via ignoreTLS
      rejectUnauthorized: !toBool((config as SmtpTestInput).ignoreTLS, false),
    },
  });
}

/**
 * Verify SMTP credentials/connectivity with nodemailer.verify().
 * Does not send an email.
 */
export async function testSmtpConnection(config: SmtpTestInput): Promise<ConnectionTestResult> {
  const started = Date.now();
  const host = String(config.host || '').trim();
  const port = Number(config.port || 587);
  const secure = toBool(config.secure, port === 465);

  try {
    if (!host) {
      return { success: false, message: 'SMTP host is required', error: 'Missing host' };
    }

    const transport = createSmtpTransport(config);
    await transport.verify();
    const responseTimeMs = Date.now() - started;

    return {
      success: true,
      message: `Connected to ${host}:${port} successfully`,
      details: {
        host,
        port,
        secure,
        authenticated: Boolean(config.user),
        responseTimeMs,
      },
    };
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
 */
export async function sendSmtpTestEmail(
  config: SmtpTestInput,
  to: string,
): Promise<ConnectionTestResult & { messageId?: string }> {
  const verify = await testSmtpConnection(config);
  if (!verify.success) return verify;

  const fromEmail = config.fromEmail || config.user || 'noreply@localhost';
  try {
    const transport = createSmtpTransport(config);
    const info = await transport.sendMail({
      from: config.fromName ? `"${config.fromName}" <${fromEmail}>` : fromEmail,
      to,
      subject: 'Inbox Flow SMTP test',
      text: 'Your SMTP connection is working. This is a test message from Inbox Flow.',
      html: '<p>Your SMTP connection is working.</p><p>This is a test message from Inbox Flow.</p>',
    });
    return {
      ...verify,
      message: `Connected and sent test email to ${to}`,
      messageId: info.messageId,
    };
  } catch (error) {
    return {
      success: false,
      message: 'SMTP verified but sending test email failed',
      error: error instanceof Error ? error.message : 'Send failed',
      details: verify.details,
    };
  }
}

export async function testProviderConnection(
  type: ProviderType,
  rawConfig: unknown,
): Promise<ConnectionTestResult> {
  const config = parseProviderConfig(rawConfig);
  if (type === 'SMTP') {
    return testSmtpConnection(config);
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
  options: { portFailover?: boolean } = {},
): Promise<SendResult> {
  const config = parseConfig(rawConfig);

  try {
    switch (type) {
      case 'SMTP':
        return await sendSmtp(config, payload, { portFailover: options.portFailover });
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
};

async function sendSmtp(
  config: ProviderConfig,
  payload: SendEmailPayload,
  options: SmtpSendOptions = {},
): Promise<SendResult> {
  const host = config.host || 'localhost';
  const fromName = (payload.fromName || config.fromName || '').replaceAll('"', '');
  const fromEmail = payload.from || config.fromEmail || config.user || 'noreply@localhost';
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  if (host === 'json' || host === 'dev' || host === 'console') {
    const transport = createSmtpTransport(config);
    const info = await transport.sendMail({
      from,
      to: payload.to,
      replyTo: payload.replyTo,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: payload.headers,
    });
    console.log('[dev-send]', payload.to, payload.subject);
    return { success: true, messageId: info.messageId || `dev-${Date.now()}`, provider: 'SMTP' };
  }

  const basePort = Number(config.port || 465);
  const baseSecure = toBool(config.secure, basePort === 465);
  const attempts = options.portFailover
    ? [
        { port: basePort, secure: baseSecure },
        { port: 465, secure: true },
        { port: 587, secure: false },
      ]
    : [{ port: basePort, secure: baseSecure }];

  const seen = new Set<string>();
  const uniqueAttempts = attempts.filter((attempt) => {
    const key = `${attempt.port}:${attempt.secure}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastError = 'SMTP send failed';
  for (const attempt of uniqueAttempts) {
    try {
      const transport = createSmtpTransport({
        ...config,
        port: attempt.port,
        secure: attempt.secure,
        requireTLS: !attempt.secure && attempt.port === 587,
      });
      const info = await transport.sendMail({
        from,
        to: payload.to,
        replyTo: payload.replyTo,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        headers: payload.headers,
      });
      return { success: true, messageId: info.messageId || `smtp-${Date.now()}`, provider: 'SMTP' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'SMTP send failed';
    }
  }

  return { success: false, error: lastError, provider: 'SMTP' };
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
