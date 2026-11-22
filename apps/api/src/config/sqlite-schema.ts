import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isSqliteDatabase } from './db-kind.js';
import { repairSqliteDdl, splitSqliteScript } from './sqlite-ddl.js';

export async function ensureSqliteSchema() {
  if (!isSqliteDatabase()) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const apiRoot = join(here, '../..');
  const file = join(apiRoot, 'prisma/sqlite-bootstrap.sql');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Local database script missing at ${file}`);
  }
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require('../generated/prisma-sqlite/index.js') as {
    PrismaClient: new () => {
      $executeRawUnsafe: (sql: string) => Promise<unknown>;
      $disconnect: () => Promise<void>;
    };
  };
  const client = new PrismaClient();
  try {
    const statements = splitSqliteScript(repairSqliteDdl(raw));
    for (const statement of statements) {
      await client.$executeRawUnsafe(statement);
    }
  } finally {
    await client.$disconnect();
  }
  console.info('[sqlite] local workspace database ready');
}
