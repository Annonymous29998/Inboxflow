import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { repairSqliteDdl, splitSqliteScript } from './sqlite-ddl.js';

describe('repairSqliteDdl', () => {
  it('turns Prisma sqlite output into statements SQLite can run twice', () => {
    const fixed = repairSqliteDdl(`
CREATE TABLE "Contact" (
  "customData" JSONB NOT NULL DEFAULT {},
  "ok" BOOLEAN NOT NULL DEFAULT false,
  "on" BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "Contact_email_key" ON "Contact"("email");
CREATE INDEX "Contact_email_idx" ON "Contact"("email");
`);
    expect(fixed).not.toMatch(/JSONB|DEFAULT \{\}|DEFAULT \[\]|\bDEFAULT false\b|\bDEFAULT true\b/);
    expect(fixed).toContain('CREATE TABLE IF NOT EXISTS "Contact"');
    expect(fixed).toContain(`DEFAULT '{}'`);
    expect(fixed).toContain('DEFAULT 0');
    expect(fixed).toContain('DEFAULT 1');
    expect(fixed).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(fixed).toContain('CREATE INDEX IF NOT EXISTS "Contact_email_idx"');
    expect(repairSqliteDdl(fixed)).toBe(fixed);
  });

  it('ships a bootstrap script that creates Contact without Postgres tokens', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '../../prisma/sqlite-bootstrap.sql'), 'utf8');
    const fixed = repairSqliteDdl(sql);
    expect(fixed).not.toMatch(/JSONB|DEFAULT \{\}|DEFAULT \[\]/);
    const statements = splitSqliteScript(fixed);
    expect(statements.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "Contact"'))).toBe(true);
    expect(statements.length).toBeGreaterThan(40);
  });
});
