/** Mustache tags {{firstName}} plus Blue-style spin {Hi|Hello}. */

export const CANONICAL_FIELDS = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'name', label: 'Full name' },
  { key: 'email', label: 'Email' },
  { key: 'sender_name', label: 'Sender name' },
  { key: 'unsubscribe_url', label: 'Unsubscribe URL' },
  { key: 'physical_address', label: 'Physical address' },
] as const;

/** Tags the send pipeline already fills. Shown on the Placeholder tab. */
export const APP_PLACEHOLDERS = [
  { token: '{{firstName}}', replaces: 'Recipient first name (or guessed from the email)' },
  { token: '{{first name}}', replaces: 'Same as first name — spaced tag from imported letters' },
  { token: '{{lastName}}', replaces: 'Recipient last name' },
  { token: '{{name}}', replaces: 'Recipient full name' },
  { token: '{{email}}', replaces: 'Recipient address' },
  { token: '{{sender_name}}', replaces: 'From name used on this send' },
  { token: '{{unsubscribe_url}}', replaces: 'Unsubscribe link (filled at send)' },
  { token: '{{physical_address}}', replaces: 'Workspace physical address' },
  { token: '{Hi|Hello}', replaces: 'Spin — one greeting per recipient' },
] as const;

export type CanonicalKey = (typeof CANONICAL_FIELDS)[number]['key'];

const ALIAS: Record<string, CanonicalKey> = {
  firstname: 'firstName',
  first_name: 'firstName',
  'first name': 'firstName',
  first: 'firstName',
  fname: 'firstName',
  vorname: 'firstName',
  lastname: 'lastName',
  last_name: 'lastName',
  'last name': 'lastName',
  last: 'lastName',
  lname: 'lastName',
  surname: 'lastName',
  name: 'name',
  fullname: 'name',
  full_name: 'name',
  email: 'email',
  mail: 'email',
  e_mail: 'email',
  sender_name: 'sender_name',
  sendername: 'sender_name',
  from_name: 'sender_name',
  unsubscribe_url: 'unsubscribe_url',
  unsubscribe: 'unsubscribe_url',
  unsub: 'unsubscribe_url',
  unsub_url: 'unsubscribe_url',
  physical_address: 'physical_address',
  address: 'physical_address',
  postal: 'physical_address',
  postal_address: 'physical_address',
};

/** Any `{{ … }}` tag — names, dates, spaced words, imported junk. */
const MUSTACHE_RE = /\{\{\s*([^{}]{1,120}?)\s*\}\}/g;
/** `{Hi|Hello}` — requires a pipe so CSS `{color:red}` is ignored. */
const SPIN_RE = /(?<!\{)\{([^{}\n]{0,400}\|[^}\n]{1,2000})\}(?!\})/g;
/** `{first_name}` / `{first name}` — not `{{x}}`, not spin, not CSS `{color:red}`. */
const BRACE_TAG_RE = /(?<!\{)\{([^{}\n:]{1,80}?)\}(?!\})/g;
const SQUARE_RE = /\[\[\s*([^[\]]{1,80}?)\s*\]\]/g;
const MAILCHIMP_RE = /\*\|([^*|]{1,60}?)\|\*/g;

export type DetectedPlaceholder =
  | { kind: 'mustache'; tag: string; token: string }
  | { kind: 'brace'; tag: string; token: string }
  | { kind: 'spin'; tag: string; token: string; parts: string[] };

export function extractBraceTags(html: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const re = new RegExp(BRACE_TAG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1] || '';
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    order.push(raw);
  }
  return order;
}

function pushUnique(
  out: DetectedPlaceholder[],
  seen: Set<string>,
  item: DetectedPlaceholder,
) {
  const key = item.token.toLowerCase();
  if (!item.tag || seen.has(key)) return;
  seen.add(key);
  out.push(item);
}

function looksLikeCss(tag: string) {
  return /[:;/\\]|^\d+$/.test(tag) || tag.includes('{');
}

export function detectPlaceholders(html: string): DetectedPlaceholder[] {
  const spins = extractSpinBlocks(html);
  const seen = new Set<string>();
  const out: DetectedPlaceholder[] = [];

  const mustacheRe = new RegExp(MUSTACHE_RE.source, 'g');
  let mm: RegExpExecArray | null;
  while ((mm = mustacheRe.exec(html))) {
    const tag = String(mm[1] || '').trim().replace(/\s+/g, ' ');
    if (!tag || looksLikeCss(tag)) continue;
    pushUnique(out, seen, { kind: 'mustache', tag, token: mm[0] || `{{${tag}}}` });
  }

  for (const token of spins) {
    const inner = token.slice(1, -1);
    const parts = inner.split('|').map((p) => p.trim()).filter(Boolean);
    pushUnique(out, seen, { kind: 'spin', tag: inner, token, parts });
  }

  const braceRe = new RegExp(BRACE_TAG_RE.source, 'g');
  let bm: RegExpExecArray | null;
  while ((bm = braceRe.exec(html))) {
    const tag = String(bm[1] || '').trim().replace(/\s+/g, ' ');
    const token = bm[0] || `{${tag}}`;
    if (!tag || tag.includes('|') || looksLikeCss(tag)) continue;
    if (seen.has(`{{${tag.toLowerCase()}}}`)) continue;
    pushUnique(out, seen, { kind: 'brace', tag, token });
  }

  const squareRe = new RegExp(SQUARE_RE.source, 'g');
  let sm: RegExpExecArray | null;
  while ((sm = squareRe.exec(html))) {
    const tag = String(sm[1] || '').trim().replace(/\s+/g, ' ');
    if (!tag || looksLikeCss(tag)) continue;
    pushUnique(out, seen, { kind: 'mustache', tag, token: sm[0] || `[[${tag}]]` });
  }

  const mcRe = new RegExp(MAILCHIMP_RE.source, 'g');
  let mc: RegExpExecArray | null;
  while ((mc = mcRe.exec(html))) {
    const tag = String(mc[1] || '').trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    pushUnique(out, seen, { kind: 'mustache', tag, token: mc[0] || `*|${tag}|*` });
  }

  return out;
}

export function replacePlaceholderToken(html: string, token: string, next: string): string {
  if (!token || next === token) return html;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(escaped, 'g'), next);
}

/** Strip a tag from the letter. Drops an enclosing <a href="{{tag}}">…</a> when the href is only that tag. */
export function removePlaceholderToken(html: string, token: string): string {
  if (!token) return html;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let next = html.replace(
    new RegExp(`<a\\b[^>]*href\\s*=\\s*(["'])${escaped}\\1[^>]*>[\\s\\S]*?<\\/a>`, 'gi'),
    '',
  );
  next = next.replace(new RegExp(escaped, 'g'), '');
  return next;
}

export function spinTokenFromLines(text: string): string {
  const parts = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0]!;
  return `{${parts.join('|')}}`;
}

export function extractMustacheTags(html: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const re = new RegExp(MUSTACHE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = String(m[1] || '').trim().replace(/\s+/g, ' ');
    if (!raw || looksLikeCss(raw) || seen.has(raw)) continue;
    seen.add(raw);
    order.push(raw);
  }
  return order;
}

export function extractSpinBlocks(html: string): string[] {
  const out: string[] = [];
  const re = new RegExp(SPIN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const inner = `{${m[1]}}`;
    if (!out.includes(inner)) out.push(inner);
  }
  return out;
}

export function suggestCanonical(tag: string): CanonicalKey | '' {
  const k = tag.trim().replace(/[-.\s]+/g, '_').replace(/_+/g, '_').toLowerCase();
  const spaced = tag.trim().replace(/\s+/g, ' ').toLowerCase();
  return (
    ALIAS[k] ||
    ALIAS[spaced] ||
    (CANONICAL_FIELDS.some((f) => f.key === tag) ? (tag as CanonicalKey) : '')
  );
}

export function renameMustacheTag(html: string, from: string, to: string): string {
  const src = from.trim();
  const dest = to.trim();
  if (!src || !dest || src === dest) return html;
  const re = new RegExp(`\\{\\{\\s*${escapeReg(src)}\\s*\\}\\}`, 'gi');
  return html.replace(re, `{{${dest}}}`);
}

export function applyPlaceholderMap(html: string, map: Record<string, string>): string {
  let out = html;
  for (const [from, to] of Object.entries(map)) {
    if (!from || !to || from === to) continue;
    out = renameMustacheTag(out, from, to);
  }
  return out;
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function applySpin(template: string, seed: string): string {
  return template.replace(new RegExp(SPIN_RE.source, 'g'), (full, inner: string) => {
    const parts = String(inner)
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) return full;
    const i = hashSeed(`${seed}::${inner}`) % parts.length;
    return parts[i]!;
  });
}

export function fillMustache(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(new RegExp(MUSTACHE_RE.source, 'g'), (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key] ?? '';
    const canon = suggestCanonical(key);
    if (canon && Object.prototype.hasOwnProperty.call(vars, canon)) return vars[canon] ?? '';
    const lower = String(key).toLowerCase();
    for (const [k, v] of Object.entries(vars)) {
      if (k.toLowerCase() === lower) return v ?? '';
    }
    return full;
  });
}

export type PreviewContact = {
  id?: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  customData?: Record<string, unknown> | null;
};

export function customDataRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || value == null) continue;
    out[name] = String(value);
  }
  return out;
}

export function previewMergeVars(input: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  senderName?: string | null;
  physicalAddress?: string | null;
  unsubscribeUrl?: string;
  customData?: unknown;
}): Record<string, string> {
  const firstName = String(input.firstName || '').trim() || guessFirst(input.email);
  const lastName = String(input.lastName || '').trim();
  const name = [firstName, lastName].filter(Boolean).join(' ') || input.email;
  const custom = customDataRecord(input.customData);
  if (input.phone && !custom.phone) custom.phone = String(input.phone).trim();
  return {
    ...custom,
    firstName,
    lastName,
    name,
    email: input.email,
    sender_name: String(input.senderName || '').trim(),
    senderName: String(input.senderName || '').trim(),
    unsubscribe_url: input.unsubscribeUrl || '#unsubscribe',
    physical_address: String(input.physicalAddress || '').trim(),
  };
}

export function applySpinPools(
  template: string,
  pools: Record<string, string[]> | null | undefined,
  seed: string,
): string {
  if (!pools) return template;
  let out = template;
  for (const [tag, lines] of Object.entries(pools)) {
    const key = String(tag || '').trim();
    const parts = (lines || []).map((l) => String(l).trim()).filter(Boolean);
    if (!key || !parts.length) continue;
    const pick = parts[hashSeed(`${seed}::${key}`) % parts.length]!;
    const esc = escapeReg(key);
    out = out.replace(new RegExp(`\\{\\{\\s*${esc}\\s*\\}\\}`, 'gi'), pick);
    out = out.replace(new RegExp(`(?<!\\{)\\{${esc}\\}(?!\\})`, 'gi'), pick);
  }
  return out;
}

export function previewLetterHtml(
  html: string,
  vars: Record<string, string>,
  map: Record<string, string>,
  seed: string,
  spinPools?: Record<string, string[]>,
): string {
  const rewritten = applyPlaceholderMap(html, map);
  const spunPools = applySpinPools(rewritten, spinPools, seed);
  return applySpin(fillMustache(spunPools, vars), seed);
}

function guessFirst(email: string) {
  const local = String(email || '').split('@')[0] || '';
  const seg = local.replace(/\d+/g, '').split(/[._+\-]/).find((p) => p.length >= 2) || '';
  return seg ? seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase() : '';
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CampaignAttachment = {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
  /** Unticked files stay on the campaign and are left off the send. */
  enabled?: boolean;
};

export const ATTACH_MAX_FILES = 10;
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function activeAttachments(list: CampaignAttachment[]) {
  return list.filter((file) => file.enabled !== false && file.filename && file.contentBase64);
}

const AUDIO_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  opus: 'audio/opus',
  weba: 'audio/webm',
  mid: 'audio/midi',
  midi: 'audio/midi',
  amr: 'audio/amr',
  caf: 'audio/x-caf',
};

/** Keep audio typed as audio when the browser reports a blank type. */
export function attachmentContentType(filename: string, given?: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fromName = AUDIO_BY_EXT[ext];
  const raw = (given || '').split(';')[0].trim().toLowerCase();
  if (raw === 'audio/mp3' || raw === 'audio/x-mpeg' || raw === 'audio/mpeg3') return 'audio/mpeg';
  if (fromName) return fromName;
  if (raw.startsWith('audio/')) return raw;
  if (raw && raw !== 'application/octet-stream') return raw;
  return 'application/octet-stream';
}

export function attachmentKind(file: { filename: string; contentType: string }) {
  const type = attachmentContentType(file.filename, file.contentType);
  if (type.startsWith('audio/')) return 'Audio';
  if (type.startsWith('image/')) return 'Image';
  if (type === 'application/pdf') return 'PDF';
  return type;
}

/** Real mailbox attachment. The letter body stays editable. */
export async function fileToAttachment(file: File): Promise<CampaignAttachment> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    filename: file.name,
    contentType: attachmentContentType(file.name, file.type),
    contentBase64: btoa(binary),
    size: file.size,
    enabled: true,
  };
}

/** Add mailbox files. Any type is allowed. Images added here stay downloads, not pictures inside the letter. */
export async function appendAttachments(current: CampaignAttachment[], files: File[]) {
  const next = [...current];
  const notes: string[] = [];
  for (const file of files) {
    if (!file.size) {
      notes.push(`${file.name} is empty`);
      continue;
    }
    if (next.length >= ATTACH_MAX_FILES) {
      notes.push(`A letter can carry ${ATTACH_MAX_FILES} files`);
      break;
    }
    if (file.size > ATTACH_MAX_BYTES) {
      notes.push(`${file.name} is over ${formatAttachmentSize(ATTACH_MAX_BYTES)}`);
      continue;
    }
    if (next.some((item) => item.filename === file.name)) {
      notes.push(`${file.name} is already attached`);
      continue;
    }
    const total = next.reduce((sum, item) => sum + item.size, 0) + file.size;
    if (total > ATTACH_MAX_TOTAL_BYTES) {
      notes.push(`Attachments together are over ${formatAttachmentSize(ATTACH_MAX_TOTAL_BYTES)}`);
      break;
    }
    next.push(await fileToAttachment(file));
  }
  return { next, notes };
}
