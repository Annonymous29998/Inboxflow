import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isSqliteDatabase } from './db-kind.js';

export function ensureSqliteSchema() {
  if (!isSqliteDatabase()) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const apiRoot = join(here, '../..');
  const schema = join(apiRoot, 'prisma/schema.sqlite.prisma');
  const require = createRequire(import.meta.url);
  let cli: string;
  try {
    cli = require.resolve('prisma/build/index.js');
  } catch {
    console.warn('[sqlite] prisma CLI missing; skip db push');
    return;
  }
  const result = spawnSync(process.execPath, [cli, 'db', 'push', '--schema', schema, '--skip-generate'], {
    cwd: apiRoot,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'prisma db push failed for local workspace');
  }
  console.info('[sqlite] local workspace database ready');
}
