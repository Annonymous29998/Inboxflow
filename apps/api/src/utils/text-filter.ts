import { isSqliteDatabase } from '../config/db-kind.js';

/** Postgres can ask for case-insensitive text. SQLite rejects `mode` and already folds ASCII case. */
export function textContains(value: string) {
  return isSqliteDatabase() ? { contains: value } : { contains: value, mode: 'insensitive' as const };
}

export function textEquals(value: string) {
  return isSqliteDatabase() ? { equals: value } : { equals: value, mode: 'insensitive' as const };
}
