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

const SPIN_RE = /(?<!\{)\{([^{}\n]{0,400}\|[^}\n]{1,2000})\}(?!\})/g;
const BRACE_TAG_RE = /(?<!\{)\{([A-Za-z][A-Za-z0-9_. -]{0,40}?)\}(?!\})/g;
const MUSTACHE_ANY_RE = /\{\{\s*([^{}]{1,120}?)\s*\}\}/g;

const BRACE_ALIAS: Record<string, 'firstName' | 'lastName' | 'name' | 'email' | 'sender_name' | 'unsubscribe_url' | 'physical_address'> = {
  first_name: 'firstName',
  firstname: 'firstName',
  'first name': 'firstName',
  fname: 'firstName',
  last_name: 'lastName',
  lastname: 'lastName',
  'last name': 'lastName',
  mename: 'sender_name',
  sender_name: 'sender_name',
  email: 'email',
  unsubscribe: 'unsubscribe_url',
  unsub: 'unsubscribe_url',
};

function aliasKey(raw: string) {
  return String(raw || '')
    .trim()
    .replace(/[-.\s]+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function resolveAlias(raw: string) {
  const spaced = String(raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return BRACE_ALIAS[spaced] || BRACE_ALIAS[aliasKey(raw)] || null;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** One-per-line pools from the Placeholder tab (`{{date}}` → 10 / 20 …). */
export function applySpinPools(
  template: string,
  pools: Record<string, string[]> | null | undefined,
  seed: string,
): string {
  if (!pools) return template;
  let out = String(template || '');
  for (const [tag, lines] of Object.entries(pools)) {
    const key = String(tag || '').trim();
    const parts = (lines || []).map((l) => String(l).trim()).filter(Boolean);
    if (!key || !parts.length) continue;
    const pick = parts[hashSeed(`${seed}::${key}`) % parts.length]!;
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\{\\{\\s*${esc}\\s*\\}\\}`, 'gi'), pick);
    out = out.replace(new RegExp(`(?<!\\{)\\{${esc}\\}(?!\\})`, 'gi'), pick);
  }
  return out;
}

/** `{Hi|Hello|Hey}` — one variant per recipient (seeded by email). */
export function applySpin(template: string, seed: string): string {
  return String(template || '').replace(new RegExp(SPIN_RE.source, 'g'), (full, inner: string) => {
    const parts = String(inner)
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) return full;
    return parts[hashSeed(`${seed}::${inner}`) % parts.length]!;
  });
}

/** Rewrite imported {{FNAME}} → {{firstName}} using the campaign map. */
export function applyPlaceholderMap(template: string, map: Record<string, string> | null | undefined): string {
  if (!map) return template;
  let out = template;
  for (const [from, to] of Object.entries(map)) {
    const src = String(from || '').trim();
    const dest = String(to || '').trim();
    if (!src || !dest || src === dest) continue;
    const re = new RegExp(`\\{\\{\\s*${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
    out = out.replace(re, `{{${dest}}}`);
  }
  return out;
}

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
    physicalAddress?: string | null;
    placeholderMap?: Record<string, string> | null;
    spinPools?: Record<string, string[]> | null;
    spinSeed?: string | null;
  },
) {
  const custom = (contact.customData || {}) as Record<string, string>;
  const firstName = resolveFirstName(contact);
  const lastName = String(contact.lastName || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || contact.email;
  const senderName = String(vars?.senderName ?? '').trim();
  const physical = String(vars?.physicalAddress ?? '').trim();

  const seed = String(vars?.spinSeed || contact.email || '');
  let out = applyPlaceholderMap(template, vars?.placeholderMap);
  out = applySpinPools(out, vars?.spinPools, seed);
  out = applySpin(out, seed);
  const known: Record<string, string> = {
    firstName,
    lastName,
    name: fullName,
    email: contact.email,
    sender_name: senderName,
    senderName,
    physical_address: physical,
  };
  out = out.replace(new RegExp(MUSTACHE_ANY_RE.source, 'g'), (full, key: string) => {
    const alias = resolveAlias(key);
    if (alias === 'unsubscribe_url') return full;
    if (alias && Object.prototype.hasOwnProperty.call(known, alias === 'sender_name' ? 'sender_name' : alias)) {
      if (alias === 'sender_name' && !(vars && Object.prototype.hasOwnProperty.call(vars, 'senderName'))) return full;
      if (alias === 'physical_address' && !physical) return full;
      if (alias === 'sender_name') return senderName;
      return known[alias] ?? full;
    }
    const compact = String(key).replace(/\s+/g, '');
    if (Object.prototype.hasOwnProperty.call(known, compact)) return known[compact] ?? full;
    return full;
  });

  if (vars && Object.prototype.hasOwnProperty.call(vars, 'senderName')) {
    out = out
      .replace(/\{\{\s*sender_name\s*\}\}/gi, senderName)
      .replace(/\{\{\s*senderName\s*\}\}/gi, senderName);
  }
  if (physical) {
    out = out.replace(/\{\{\s*physical_address\s*\}\}/gi, physical);
  }

  out = out.replace(new RegExp(BRACE_TAG_RE.source, 'g'), (full, key: string) => {
    const alias = resolveAlias(key);
    if (!alias) return full;
    if (alias === 'firstName') return firstName;
    if (alias === 'lastName') return lastName;
    if (alias === 'name') return fullName;
    if (alias === 'email') return contact.email;
    if (alias === 'sender_name') return senderName;
    if (alias === 'physical_address') return physical;
    return full;
  });

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
