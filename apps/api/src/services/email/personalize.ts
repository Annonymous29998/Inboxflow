/**
 * Derive a first name from the email local-part only when it looks like a real name.
 * Skips addresses with digits (e.g. ronniech78@gmail.com, john99@x.com).
 */
export function firstNameFromEmail(email: string): string {
  const local =
    String(email || '')
      .split('@')[0]
      ?.trim()
      .toLowerCase() || '';
  if (!local) return '';
  // Any digit → do not invent a first name
  if (/\d/.test(local)) return '';
  // Take first segment: john.doe → john, mary_smith → mary
  const segment = local.split(/[._+\-]+/).find((p) => p.length >= 2) || local;
  if (!/^[a-z]+$/i.test(segment) || segment.length < 2) return '';
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
