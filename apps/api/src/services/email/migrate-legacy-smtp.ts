import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { encrypt } from '../../utils/crypto.js';
import { parseProviderConfig } from './providers.js';

function normalizeConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

/** Remove SMTP profiles auto-created from env/seed (console json host, no credentials). */
export async function removeEnvBootstrappedSmtpProviders(organizationId: string) {
  const providers = await prisma.emailProvider.findMany({
    where: { organizationId, type: 'SMTP' },
  });

  for (const provider of providers) {
    const config = parseProviderConfig(provider.config);
    const host = String(config.host || '').toLowerCase();
    const isConsoleHost = host === 'json' || host === 'dev' || host === 'console';
    const noCredentials = !String(config.user || '').trim() && !String(config.pass || '').trim();

    if (provider.id === 'seed-provider-smtp' || (isConsoleHost && noCredentials)) {
      await prisma.emailProvider.delete({ where: { id: provider.id } });
    }
  }
}

/** One-time style fix: replace legacy I-Coffee branding stored in SMTP profiles. */
export async function migrateLegacySmtpBranding(organizationId: string) {
  const defaultFrom =
    env.EMAIL_FROM_ADDRESS || env.SMTP_FROM || env.SMTP_USER || 'noreply@inboxflow.io';
  const defaultName = env.EMAIL_FROM_NAME || env.APP_NAME || 'Inbox Flow';

  const providers = await prisma.emailProvider.findMany({
    where: { organizationId, type: 'SMTP' },
  });

  for (const provider of providers) {
    const config = parseProviderConfig(provider.config);
    const next: Record<string, string> = { ...config };
    let changed = false;

    const fromEmail = String(config.fromEmail || config.user || '');
    const fromName = String(config.fromName || '');

    if (/i-coffee\.ng/i.test(fromEmail)) {
      next.fromEmail = defaultFrom;
      changed = true;
    }
    if (/^I-Coffee/i.test(fromName)) {
      next.fromName = defaultName;
      changed = true;
    }

    const nameNeedsUpdate = /i-coffee/i.test(provider.name);
    const nextName = nameNeedsUpdate ? next.fromEmail || defaultFrom : provider.name;

    if (!changed && !nameNeedsUpdate) continue;

    await prisma.emailProvider.update({
      where: { id: provider.id },
      data: {
        ...(nameNeedsUpdate ? { name: nextName } : {}),
        ...(changed
          ? { config: { encrypted: encrypt(JSON.stringify(normalizeConfig(next))) } as object }
          : {}),
      },
    });
  }
}
