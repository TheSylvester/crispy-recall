/**
 * A transient SQLITE_BUSY on a migration-marker read is NOT "migration pending"
 * (L9).
 *
 * `isRetrievalMigrationPending` / `isCodexRekeyPending` used a bare
 * `catch { return true }`, so a contended marker read reported pending, the
 * opener threw MigrationPendingError — and the stop hook's `retryBusyIngest`
 * only retries `/database is locked|SQLITE_BUSY/`, so it never retried a
 * MigrationPendingError and the turn was dropped outright. Busy must propagate
 * as busy; every other error still fails closed as pending.
 *
 * Pure unit test over a fake db handle — no file, no ~/.recall.
 */
import { describe, expect, it } from 'vitest';
import { isCodexRekeyPending, isRetrievalMigrationPending } from '../../src/db.js';
import type { RecallDb } from '../../src/db.js';

function throwingDb(err: unknown, throwOnNth = 1): RecallDb {
  let calls = 0;
  return {
    get: () => {
      calls += 1;
      if (calls >= throwOnNth) throw err;
      return { 1: 1 };
    },
  } as unknown as RecallDb;
}

function busy(code: string, message = 'database is locked'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const cases: Array<[string, (d: RecallDb) => boolean]> = [
  ['isRetrievalMigrationPending', isRetrievalMigrationPending],
  ['isCodexRekeyPending', isCodexRekeyPending],
];

describe.each(cases)('%s', (_name, fn) => {
  it('rethrows SQLITE_BUSY so the caller can retry it as a busy DB', () => {
    expect(() => fn(throwingDb(busy('SQLITE_BUSY')))).toThrowError(/database is locked/);
  });

  it('rethrows SQLITE_BUSY_SNAPSHOT too', () => {
    expect(() => fn(throwingDb(busy('SQLITE_BUSY_SNAPSHOT', 'snapshot is not current'))))
      .toThrowError(/snapshot is not current/);
  });

  it('rethrows a busy reported only in the message', () => {
    expect(() => fn(throwingDb(new Error('SqliteError: database is locked'))))
      .toThrowError(/database is locked/);
  });

  it('still fails closed (pending) for a non-busy error', () => {
    expect(fn(throwingDb(Object.assign(new Error('no such table: schema_meta'), { code: 'SQLITE_ERROR' }))))
      .toBe(true);
  });

  it('still fails closed for an error with no code at all', () => {
    expect(fn(throwingDb(new Error('malformed database schema')))).toBe(true);
  });

  it('rethrows busy raised by the marker read, not just the sqlite_master probe', () => {
    // Third `get` = the schema_meta marker row itself.
    expect(() => fn(throwingDb(busy('SQLITE_BUSY'), 3))).toThrowError(/database is locked/);
  });
});
