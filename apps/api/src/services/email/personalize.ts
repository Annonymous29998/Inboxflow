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

/** Tags filled later (send-time), not from contact customData. */
const DEFERRED_TAGS = new Set([
  'sender_name',
  'sendername',
  'unsubscribe_url',
  'physical_address',
]);

export function personalize(
  template: string,
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    email: string;
    customData?: unknown;
  },
  vars?: {
    /** Campaign / SMTP display name — fills {{sender_name}} and {{senderName}} */
    senderName?: string | null;
  },
) {
  const custom = (contact.customData || {}) as Record<string, string>;
  const firstName = resolveFirstName(contact);
  const lastName = String(contact.lastName || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || contact.email;
  const senderName = String(vars?.senderName ?? '').trim();

  let out = template
    .replace(/\{\{\s*firstName\s*\}\}/gi, firstName)
    .replace(/\{\{\s*lastName\s*\}\}/gi, lastName)
    .replace(/\{\{\s*email\s*\}\}/gi, contact.email)
    .replace(/\{\{\s*name\s*\}\}/gi, fullName);

  if (vars && Object.prototype.hasOwnProperty.call(vars, 'senderName')) {
    out = out
      .replace(/\{\{\s*sender_name\s*\}\}/gi, senderName)
      .replace(/\{\{\s*senderName\s*\}\}/gi, senderName);
  }

  return out.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    if (DEFERRED_TAGS.has(String(key).toLowerCase())) return match;
    return custom[key] ?? '';
  });
}

/** Fill {{sender_name}} / {{senderName}} after the final From name is known. */
export function applySenderName(template: string, senderName: string): string {
  const name = String(senderName || '').trim();
  return template
    .replace(/\{\{\s*sender_name\s*\}\}/gi, name)
    .replace(/\{\{\s*senderName\s*\}\}/gi, name);
}
