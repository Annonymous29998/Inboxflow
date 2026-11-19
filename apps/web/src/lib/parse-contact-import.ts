import { cleanImportEmail } from '@/lib/clean-import-email';

export type ContactImportRow = {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
};

/** Parse pasted/uploaded CSV or plain emails. Each address is kept once (case-insensitive). */
export function parseContactImportRows(text: string): ContactImportRow[] {
  const rows: ContactImportRow[] = [];
  if (!text || !text.length) return rows;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return rows;
  const header = lines[0].split(/[,\t;]/).map((s) => s.trim().toLowerCase());
  const hasEmailHeader = header.includes('email') || header.includes('e-mail');
  const mapCol: Record<string, number> = {};
  header.forEach((h, i) => {
    if (h === 'email' || h === 'e-mail') mapCol.email = i;
    else if (h === 'firstname' || h === 'first_name' || h === 'first') mapCol.firstName = i;
    else if (h === 'lastname' || h === 'last_name' || h === 'last') mapCol.lastName = i;
    else if (h === 'phone' || h === 'mobile' || h === 'cell') mapCol.phone = i;
  });
  const startIdx = hasEmailHeader ? 1 : 0;
  const seen = new Set<string>();
  function pushIfUnique(row: ContactImportRow) {
    if (!row?.email) return;
    const key = row.email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  }

  const mostlyPlainList =
    !hasEmailHeader &&
    lines.length >= 3 &&
    lines.filter((l) => l.includes('@')).length >= Math.ceil(lines.length * 0.6);

  for (let i = startIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!mostlyPlainList && (rawLine.includes(',') || rawLine.includes('\t') || rawLine.includes(';'))) {
      const cols = rawLine.split(/[,\t;]/).map((s) => s.replace(/^"|"$/g, '').trim());
      let email: string | null = null;
      if (mapCol.email !== undefined) {
        email = cleanImportEmail(cols[mapCol.email] || '');
      }
      if (!email) {
        for (const c of cols) {
          email = cleanImportEmail(c);
          if (email) break;
        }
      }
      if (!email) continue;
      const firstName = mapCol.firstName !== undefined ? cols[mapCol.firstName] || undefined : undefined;
      const lastName = mapCol.lastName !== undefined ? cols[mapCol.lastName] || undefined : undefined;
      const phone = mapCol.phone !== undefined ? cols[mapCol.phone] || undefined : undefined;
      pushIfUnique({ email, firstName, lastName, phone });
    } else {
      const email = cleanImportEmail(rawLine);
      if (!email) continue;
      pushIfUnique({ email });
    }
  }
  return rows;
}

export function contactImportRowsToText(rows: ContactImportRow[]): string {
  const header = ['email', 'firstName', 'lastName', 'phone'];
  return [header.join(','), ...rows.map((r) => [r.email, r.firstName ?? '', r.lastName ?? '', r.phone ?? ''].join(','))].join(
    '\n',
  );
}

export function countContactImportLines(text: string): number {
  return (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
}
