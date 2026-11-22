/**
 * Prisma's SQLite diff emits Postgres tokens (`JSONB`, `DEFAULT {}`, `DEFAULT false`).
 * SQLite rejects those and the desktop API exits on first launch. Repair before apply.
 */
export function repairSqliteDdl(sql: string): string {
  return sql
    .replace(/\bJSONB\b/g, 'TEXT')
    .replace(/DEFAULT\s+\{\}/g, "DEFAULT '{}'")
    .replace(/DEFAULT\s+\[\]/g, "DEFAULT '[]'")
    .replace(/\bDEFAULT false\b/g, 'DEFAULT 0')
    .replace(/\bDEFAULT true\b/g, 'DEFAULT 1')
    .replace(/CREATE TABLE (?!IF NOT EXISTS )/g, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/CREATE UNIQUE INDEX (?!IF NOT EXISTS )/g, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/CREATE INDEX (?!IF NOT EXISTS )/g, 'CREATE INDEX IF NOT EXISTS ');
}

export function splitSqliteScript(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(/;\s*\n/)
    .map((statement) => statement.trim().replace(/;+\s*$/, ''))
    .filter(Boolean);
}
