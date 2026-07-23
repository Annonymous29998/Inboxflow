/**
 * Outbound mail shape helpers for better inbox placement.
 * Cannot force Gmail/Outlook inbox — strengthens MIME, From alignment, and headers.
 */

export function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  return address.slice(at + 1).trim().toLowerCase();
}

export function buildMessageId(fromEmail: string): string {
  const domain = emailDomain(fromEmail) || 'localhost';
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return `<${id}@${domain}>`;
}

/** True when From domain looks unrelated to SMTP login (common spam signal). */
export function fromDomainMisaligned(fromEmail: string, smtpUser: string): boolean {
  const fromDom = emailDomain(fromEmail);
  const userDom = emailDomain(smtpUser);
  if (!fromDom || !userDom) return false;
  if (fromDom === userDom) return false;
  // allow subdomain match (mail.example.com vs example.com)
  if (fromDom.endsWith(`.${userDom}`) || userDom.endsWith(`.${fromDom}`)) return false;
  return true;
}

export function formatFromHeader(fromEmail: string, fromName?: string | null): string {
  const email = fromEmail.trim();
  const name = String(fromName || '').trim().replaceAll('"', '');
  return name ? `"${name}" <${email}>` : email;
}
