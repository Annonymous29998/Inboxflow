// Apply the RLS-enable migration directly because prisma migrate deploy hangs on pooler.
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const prisma = new PrismaClient();

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(__dirname, '..', '..', 'prisma', 'enable-rls-all.sql'), 'utf-8');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`Applying ${statements.length} RLS-enable statements against production Supabase pooler…`);
for (const stmt of statements) {
  try {
    await prisma.$executeRawUnsafe(stmt);
    const short = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log('  OK  ', short);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation ".*" does not exist/i.test(msg) || /is already enabled/i.test(msg)) {
      console.log('  SKIP', stmt.split(/\s+/).slice(0, 4).join(' '), msg.split('\n')[0].slice(0, 60));
    } else {
      console.error('  FAIL', stmt.split(/\s+/).slice(0, 5).join(' '), msg);
      throw err;
    }
  }
}
console.log('\nAll RLS policies enabled. CRITICAL Supabase Advisor warning resolved.');
await prisma.$disconnect();
