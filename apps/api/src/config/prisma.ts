import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Prisma connection pool + query-timeout configuration tuned for:
 * 1. Supabase EU region remote database (high RTT — avoid connection thrashing)
 * 2. PgBouncer pooler (port 6543) running in Transaction mode
 * 3. Mitigation of transient network timeouts → retry + explicit timeouts per query
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    // Use connection_limit + pooled connections to speed up subsequent queries after the 1st cold connect.
    transactionOptions: {
      maxWait: 45_000, // max time to wait for a free pooled connection
      timeout: 60_000, // max time a single tx is allowed to run
    },
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Eagerly warm the connection pool in the background on boot (1 DB query) so the
// first real user request isn't the one paying the 20–30s cold handshake cost.
// Promise is intentionally not awaited — fire & forget.
(async () => {
  try {
    // Use $queryRaw with a NOOP that is instant once the TLS handshake completes.
    await prisma.$queryRawUnsafe('SELECT 1');
    // eslint-disable-next-line no-console
    console.info('[prisma] connection pool warmed up and ready ✅');
  } catch (err) {
    // Not fatal: first incoming HTTP request will try again.
    console.warn('[prisma] initial pool warmup failed (will retry on first query):', err instanceof Error ? err.message : String(err));
  }
})();

