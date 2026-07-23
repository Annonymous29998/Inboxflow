import { parse as parseCsv } from 'csv-parse/sync';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export type ParsedContactRow = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
};

function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes('@') || email.startsWith('@')) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
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
        const email = normalizeEmail(
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
    const email = normalizeEmail(cells[0] || '');
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
          .map((item) => normalizeEmail(item))
          .filter(Boolean)
          .map((email) => ({ email: email! }));
      }
      return data
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const row = item as Record<string, unknown>;
          const email = normalizeEmail(String(row.email || row.Email || row.mail || ''));
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
  const matches = text.match(EMAIL_RE) || [];
  const seen = new Set<string>();
  const out: ParsedContactRow[] = [];
  for (const match of matches) {
    const email = normalizeEmail(match);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email });
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

  if (trimmed.includes(',') || trimmed.includes('\t') || trimmed.includes(';')) {
    const csvRows = parseCsvRows(trimmed);
    if (csvRows.length) return dedupeRows(csvRows);
  }

  // Plain text / pasted document: one email per line, or extract from body
  const lineRows = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const email = normalizeEmail(line.split(/[\s,;|]+/)[0] || line);
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
