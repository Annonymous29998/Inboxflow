import { prisma } from '../config/prisma.js';
import type { Prisma } from '@prisma/client';

export type LogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
export type LogCategory =
  | 'smtp'
  | 'queue'
  | 'campaign'
  | 'delivery'
  | 'bounce'
  | 'auth'
  | 'system';

export async function writeSystemLog(input: {
  organizationId: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  meta?: Prisma.InputJsonValue;
}) {
  try {
    await prisma.systemLog.create({
      data: {
        organizationId: input.organizationId,
        level: input.level,
        category: input.category,
        message: input.message,
        meta: input.meta ?? undefined,
      },
    });
  } catch (err) {
    console.error('[system-log]', err);
  }
}

export function detectSmtpConfigIssues(config: {
  host?: string;
  port?: string | number;
  encryption?: string;
  secure?: boolean | string;
  requireTLS?: boolean | string;
  user?: string;
  pass?: string;
  fromEmail?: string;
}) {
  const issues: string[] = [];
  const host = String(config.host || '').trim().toLowerCase();
  const port = Number(config.port || 0);
  const encryption = String(config.encryption || '').toUpperCase();
  const secure =
    config.secure === true ||
    config.secure === 'true' ||
    encryption === 'SSL' ||
    encryption === 'TLS';

  if (!host) issues.push('SMTP host is missing');
  if (!port || port < 1 || port > 65535) issues.push('SMTP port is invalid');
  if (!config.user) issues.push('Username is empty — most providers require authentication');
  if (!config.pass) issues.push('Password is empty');
  if (!config.fromEmail && !config.user) issues.push('Sender email is missing');

  if (port === 465 && !secure && encryption !== 'SSL') {
    issues.push('Port 465 usually requires SSL/TLS (secure=true)');
  }
  if (port === 587 && secure) {
    issues.push('Port 587 usually uses STARTTLS (secure=false, requireTLS=true)');
  }
  if (host.includes('gmail') && port === 465 && !secure) {
    issues.push('Gmail on 465 expects SSL');
  }
  if (host.includes('gmail') && !config.pass) {
    issues.push('Gmail often requires an App Password, not the account password');
  }
  if (host.includes('office365') || host.includes('outlook')) {
    if (port !== 587) issues.push('Outlook / Microsoft 365 typically uses port 587 with STARTTLS');
  }
  if (host.includes('sendgrid') && config.user && config.user !== 'apikey') {
    issues.push('SendGrid SMTP username is usually literally "apikey"');
  }

  return issues;
}
