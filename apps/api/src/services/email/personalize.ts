/**
 * Derive a first name from the email local-part when no contact first name is saved.
 * Digits are stripped (ronniech78 → Ronniech); only letters are used.
 */
export function firstNameFromEmail(email: string): string {
  const local =
    String(email || '')
      .split('@')[0]
      ?.trim()
      .toLowerCase() || '';
  if (!local) return '';

  // Remove digits entirely — keep letter name only (ronniech78 → ronniech)
  const withoutDigits = local.replace(/\d+/g, '');
  // Split on common separators, prefer first alphabetic segment
  const segment =
    withoutDigits
      .split(/[._+\-]+/)
      .map((p) => p.replace(/[^a-z]/gi, ''))
      .find((p) => p.length >= 2) || withoutDigits.replace(/[^a-z]/gi, '');

  if (!segment || segment.length < 2) return '';
  return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
}

function resolveFirstName(contact: {
  firstName?: string | null;
  email: string;
}): string {
  const saved = String(contact.firstName || '').trim();
  if (saved) return saved;
  return firstNameFromEmail(contact.email);
}

export function personalize(
  template: string,
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    email: string;
    customData?: unknown;
  },
) {
  const custom = (contact.customData || {}) as Record<string, string>;
  const firstName = resolveFirstName(contact);
  const lastName = String(contact.lastName || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || contact.email;
  return template
    .replace(/\{\{\s*firstName\s*\}\}/gi, firstName)
    .replace(/\{\{\s*lastName\s*\}\}/gi, lastName)
    .replace(/\{\{\s*email\s*\}\}/gi, contact.email)
    .replace(/\{\{\s*name\s*\}\}/gi, fullName)
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => custom[key] ?? '');
}
