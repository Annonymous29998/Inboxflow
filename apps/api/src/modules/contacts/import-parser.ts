import { parse as parseCsv } from 'csv-parse/sync';

export type ParsedContactRow = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
};

/** Reject TLDs that are clearly paste/OCR junk, not real domains. */
const JUNK_TLDS = new Set(['read', 'unread', 'mailto', 'http', 'https', 'www']);

/**
 * Clean a pasted/uploaded token into a single email.
 * Strips trailing `.`, `.Read` / `Read`, counts like `(75)`, and extracts
 * the email when phone digits or other junk is glued on.
 */
export function cleanImportEmail(raw: string): string | null {
  if (!raw?.trim()) return null;

  let s = raw.trim().toLowerCase();
  s = s.replace(/^["'\s<]+/, '').replace(/["'\s>]+$/, '');
  s = s.replace(/\(\s*\d+\s*\)\s*$/, '');
  // OCR / PDF junk glued to the address: net.Read, netRead, .Unread
  s = s.replace(/(?:\.|_)?(?:un)?read$/i, '');
  s = s.replace(/[.\s,;:!?]+$/g, '');

  if (isValidEmailShape(s)) return finalizeLocalPart(s);

  // Extract from messier lines (labels, phone prefixes, etc.)
  const working = s;
  const matches = [...working.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    let candidate = matches[i]![0];
    candidate = candidate.replace(/(?:\.|_)?(?:un)?read$/i, '');
    candidate = candidate.replace(/\.+$/g, '');
    if (isValidEmailShape(candidate)) return finalizeLocalPart(candidate);
  }

  return null;
}

function isValidEmailShape(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (JUNK_TLDS.has(tld)) return false;
  if (tld.length < 2) return false;
  return true;
}

/** If a US-style phone is glued into the local part, keep only the email-looking tail. */
function finalizeLocalPart(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  // States717-517-4293dsensenig → dsensenig
  const phoneMatch = local.match(/^(.*?)(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})(.*)$/);
  if (phoneMatch) {
    const after = (phoneMatch[3] || '').replace(/^[^a-z0-9]+/i, '');
    if (after && /[a-z]/i.test(after)) {
      local = after;
    }
  }
  const out = `${local}@${domain}`;
  return isValidEmailShape(out) ? out : email;
}

/** @deprecated use cleanImportEmail */
function normalizeEmail(raw: string): string | null {
  return cleanImportEmail(raw);
}

function pickField(row: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const val = row[key]?.trim();
    if (val) return val;
  }
  return null;
}

function parseCsvRows(text: string): ParsedContactRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const split = (line: string) =>
    line.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ''));

  const headerCells = split(lines[0]).map((h) => h.toLowerCase());
  const hasEmailHeader = headerCells.some((h) =>
    ['email', 'e-mail', 'mail', 'email address', 'email_address'].includes(h),
  );

  if (hasEmailHeader) {
    const rows = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];

    return rows
      .map((row) => {
        const email = cleanImportEmail(
          pickField(row, ['email', 'Email', 'EMAIL', 'e-mail', 'mail', 'Email Address']) || '',
        );
        if (!email) return null;
        return {
          email,
          firstName: pickField(row, ['firstName', 'first_name', 'FirstName', 'first name', 'given_name']),
          lastName: pickField(row, ['lastName', 'last_name', 'LastName', 'last name', 'surname', 'family_name']),
          phone: pickField(row, ['phone', 'Phone', 'mobile', 'tel']),
        };
      })
      .filter(Boolean) as ParsedContactRow[];
  }

  // Headerless: one email per row or first column is email
  const out: ParsedContactRow[] = [];
  for (const line of lines) {
    const cells = split(line);
    const email = cleanImportEmail(cells[0] || '') || cleanImportEmail(line);
    if (!email) continue;
    out.push({
      email,
      firstName: cells[1] || null,
      lastName: cells[2] || null,
      phone: cells[3] || null,
    });
  }
  return out;
}

function parseJsonRows(text: string): ParsedContactRow[] | null {
  try {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) {
      if (data.every((item) => typeof item === 'string')) {
        return data
          .map((item) => cleanImportEmail(item))
          .filter(Boolean)
          .map((email) => ({ email: email! }));
      }
      return data
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const row = item as Record<string, unknown>;
          const email = cleanImportEmail(String(row.email || row.Email || row.mail || ''));
          if (!email) return null;
          return {
            email,
            firstName: row.firstName ? String(row.firstName) : row.first_name ? String(row.first_name) : null,
            lastName: row.lastName ? String(row.lastName) : row.last_name ? String(row.last_name) : null,
            phone: row.phone ? String(row.phone) : null,
          };
        })
        .filter(Boolean) as ParsedContactRow[];
    }
    return null;
  } catch {
    return null;
  }
}

function extractEmailsFromText(text: string): ParsedContactRow[] {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const out: ParsedContactRow[] = [];
  for (const line of lines) {
    const email = cleanImportEmail(line);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email });
  }
  // Fallback: scan whole blob if line-by-line found nothing
  if (!out.length) {
    const matches = text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/g) || [];
    for (const match of matches) {
      const email = cleanImportEmail(match);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({ email });
    }
  }
  return out;
}

/** Parse contacts from CSV, TSV, JSON, or any text (emails extracted automatically). */
export function parseContactImport(content: string): ParsedContactRow[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const jsonRows = parseJsonRows(trimmed);
    if (jsonRows?.length) return dedupeRows(jsonRows);
  }

  // Prefer line-oriented cleaning for pasted email lists (even if commas appear in junk).
  const lineOriented = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const mostlyOneTokenPerLine =
    lineOriented.length >= 3 &&
    lineOriented.filter((l) => l.includes('@')).length >= Math.ceil(lineOriented.length * 0.6);

  if (mostlyOneTokenPerLine) {
    const lineRows = lineOriented
      .map((line) => {
        const email = cleanImportEmail(line);
        return email ? { email } : null;
      })
      .filter(Boolean) as ParsedContactRow[];
    if (lineRows.length) return dedupeRows(lineRows);
  }

  if (trimmed.includes(',') || trimmed.includes('\t') || trimmed.includes(';')) {
    const csvRows = parseCsvRows(trimmed);
    if (csvRows.length) return dedupeRows(csvRows);
  }

  const lineRows = lineOriented
    .map((line) => {
      const email = cleanImportEmail(line.split(/[\s,;|]+/)[0] || line) || cleanImportEmail(line);
      return email ? { email } : null;
    })
    .filter(Boolean) as ParsedContactRow[];

  if (lineRows.length) return dedupeRows(lineRows);

  return dedupeRows(extractEmailsFromText(trimmed));
}

function dedupeRows(rows: ParsedContactRow[]): ParsedContactRow[] {
  const seen = new Set<string>();
  const out: ParsedContactRow[] = [];
  for (const row of rows) {
    if (seen.has(row.email)) continue;
    seen.add(row.email);
    out.push(row);
  }
  return out;
}

// keep export for any older imports
export { normalizeEmail };
