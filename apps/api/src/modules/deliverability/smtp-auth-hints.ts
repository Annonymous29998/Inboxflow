/**
 * Map SMTP hosts to the SPF mechanisms Gmail actually checks for that sender.
 * Brevo ≠ SMTP Provider (akoneseo). Do not mix their IPs.
 */

export type SmtpAuthHint = {
  id: string;
  label: string;
  match: RegExp;
  /** Mechanisms to merge into the From-domain SPF TXT (no v=spf1 / all). */
  spfMechanisms: string[];
  dkimHint: string;
};

export const SMTP_AUTH_HINTS: SmtpAuthHint[] = [
  {
    id: 'brevo',
    label: 'Brevo',
    match: /brevo|sendinblue|smtp-relay\.brevo/i,
    spfMechanisms: ['include:spf.brevo.com'],
    dkimHint:
      'In Brevo → Senders, Domains & IPs → Domains, authenticate this From domain and publish the exact brevo-code TXT plus brevo1/brevo2 (or mail._domainkey) CNAMEs Brevo shows. Inbox Flow DKIM is not a substitute.',
  },
  {
    id: 'akoneseo',
    label: 'SMTP Provider',
    match: /akoneseo|smtpprovider|client\.inboxingsend/i,
    spfMechanisms: ['ip4:136.243.17.45'],
    dkimHint: 'Keep the smtp._domainkey TXT your SMTP Provider issued. Do not replace it with Inbox Flow’s key.',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    match: /sendgrid/i,
    spfMechanisms: ['include:sendgrid.net'],
    dkimHint: 'Authenticate the From domain in SendGrid and publish their CNAME records.',
  },
  {
    id: 'mailgun',
    label: 'Mailgun',
    match: /mailgun/i,
    spfMechanisms: ['include:mailgun.org'],
    dkimHint: 'Publish Mailgun’s DKIM TXT/CNAME from their domain settings.',
  },
  {
    id: 'postmark',
    label: 'Postmark',
    match: /postmark/i,
    spfMechanisms: ['include:spf.mtasv.net'],
    dkimHint: 'Publish the DKIM record Postmark shows for this domain.',
  },
  {
    id: 'ses',
    label: 'Amazon SES',
    match: /amazonaws\.com|email-smtp\./i,
    spfMechanisms: ['include:amazonses.com'],
    dkimHint: 'Verify the domain in SES and publish the three DKIM CNAMEs Amazon shows.',
  },
];

export function hintsForSmtpHost(host: string): SmtpAuthHint[] {
  const h = String(host || '').trim();
  if (!h) return [];
  return SMTP_AUTH_HINTS.filter((hint) => hint.match.test(h));
}

export function hintsForSmtpHosts(hosts: Array<string | null | undefined>): SmtpAuthHint[] {
  const seen = new Set<string>();
  const out: SmtpAuthHint[] = [];
  for (const host of hosts) {
    for (const hint of hintsForSmtpHost(host || '')) {
      if (seen.has(hint.id)) continue;
      seen.add(hint.id);
      out.push(hint);
    }
  }
  return out;
}

/** Merge provider includes into an existing SPF (or start a new one). */
export function mergeSpfRecord(existingSpf: string | null | undefined, mechanisms: string[]): string {
  const raw = String(existingSpf || '').trim();
  const found = new Set<string>();
  const tokens: string[] = [];

  if (raw.toLowerCase().startsWith('v=spf1')) {
    for (const token of raw.split(/\s+/).slice(1)) {
      const t = token.trim();
      if (!t) continue;
      if (/^[-~?+]?all$/i.test(t)) continue;
      const key = t.toLowerCase();
      if (found.has(key)) continue;
      found.add(key);
      tokens.push(t);
    }
  }

  for (const mech of mechanisms) {
    const t = mech.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (found.has(key)) continue;
    found.add(key);
    tokens.push(t);
  }

  if (!tokens.length) tokens.push('include:_spf.inboxflow.io');
  return `v=spf1 ${tokens.join(' ')} ~all`;
}

export function recommendedSpfForHosts(
  hosts: Array<string | null | undefined>,
  existingSpf?: string | null,
): { record: string; hints: SmtpAuthHint[] } {
  const hints = hintsForSmtpHosts(hosts);
  const mechanisms = hints.flatMap((h) => h.spfMechanisms);
  return { record: mergeSpfRecord(existingSpf, mechanisms), hints };
}

export function missingSpfMechanisms(liveSpf: string, required: string[]): string[] {
  const live = liveSpf.toLowerCase();
  return required.filter((mech) => !live.includes(mech.toLowerCase()));
}
