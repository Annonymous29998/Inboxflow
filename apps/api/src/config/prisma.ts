import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { isSqliteDatabase } from './db-kind.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  if (isSqliteDatabase()) {
    const require = createRequire(import.meta.url);
    const { PrismaClient: SqliteClient } = require('../generated/prisma-sqlite/index.js') as {
      PrismaClient: new (args?: unknown) => PrismaClient;
    };
    return new SqliteClient({
      log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
  }
  return new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    transactionOptions: {
      maxWait: 45_000,
      timeout: 60_000,
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

void (async () => {
  try {
    if (isSqliteDatabase()) {
      await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
      await prisma.$queryRawUnsafe('PRAGMA busy_timeout=8000');
      await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
      await prisma.$queryRawUnsafe('PRAGMA foreign_keys=ON');
    }
    await prisma.$queryRawUnsafe('SELECT 1');
    console.info('[prisma] connection pool warmed up and ready ✅');
  } catch (err) {
    console.warn(
      '[prisma] initial pool warmup failed (will retry on first query):',
      err instanceof Error ? err.message : String(err),
    );
  }
})();
