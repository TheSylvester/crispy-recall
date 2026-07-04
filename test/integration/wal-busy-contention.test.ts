/**
 * WAL busy contention — overlapping `BEGIN IMMEDIATE` retries then succeeds.
 *
 * Two real processes both take a write transaction on the same DB. Process A
 * holds the write lock for ~800 ms; Process B starts while A holds it and must
 * WAIT on busy_timeout (not error, not corrupt), then commit once A releases.
 * This proves the busy handler serializes writers — the behavior that makes
 * `database is locked` disappear under real WAL.
 *
 * Children run as `node -e` with cwd=repo root so `require('better-sqlite3')`
 * resolves the repo addon.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, _resetDb } from '../../src/db.js';

const ROOT = join(__dirname, '..', '..');

/** Holder: take the write lock, hold it BC_HOLD ms (synchronous), commit. */
const HOLDER_CODE = `
const Database = require('better-sqlite3');
const db = new Database(process.env.BC_DB);
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO t(id, v) VALUES (?, ?)').run(process.env.BC_ID, 'holder');
// Synchronous hold — keep the write lock across a real wall-clock interval.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, +process.env.BC_HOLD);
db.exec('COMMIT');
db.close();
process.exit(0);
`;

/** Waiter: measure how long BEGIN IMMEDIATE blocks before it succeeds. */
const WAITER_CODE = `
const Database = require('better-sqlite3');
const db = new Database(process.env.BC_DB);
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
const t0 = Date.now();
db.exec('BEGIN IMMEDIATE');            // blocks until the holder commits
const waited = Date.now() - t0;
db.prepare('INSERT INTO t(id, v) VALUES (?, ?)').run(process.env.BC_ID, 'waiter');
db.exec('COMMIT');
db.close();
process.stderr.write('waited=' + waited);
process.exit(0);
`;

interface ChildResult {
  exitCode: number | null;
  stderr: string;
}

function runChild(code: string, env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stderr }));
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('WAL busy contention', () => {
  let dir: string;

  afterEach(() => {
    _resetDb();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('a contended BEGIN IMMEDIATE waits then succeeds — never errors or corrupts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-busy-'));
    const dbFile = join(dir, 'recall.db');

    // Create the table via the real driver (WAL fixture), then release.
    const setup = getDb(dbFile);
    setup.exec('CREATE TABLE t(id TEXT PRIMARY KEY, v TEXT)');
    _resetDb();

    const HOLD = 800;
    const baseEnv = { ...process.env, BC_DB: dbFile };

    // Start the holder, wait until it has surely taken BEGIN IMMEDIATE, then
    // start the waiter so it collides with a live write lock.
    const holder = runChild(HOLDER_CODE, { ...baseEnv, BC_ID: 'a', BC_HOLD: String(HOLD) });
    await delay(250);
    const waiter = runChild(WAITER_CODE, { ...baseEnv, BC_ID: 'b', BC_HOLD: '0' });

    const [rHolder, rWaiter] = await Promise.all([holder, waiter]);

    expect(rHolder.exitCode).toBe(0);
    expect(rWaiter.exitCode).toBe(0);
    for (const r of [rHolder, rWaiter]) {
      expect(r.stderr).not.toMatch(/database is locked/i);
      expect(r.stderr).not.toMatch(/SQLITE_BUSY/i);
    }

    // The waiter blocked on the holder's lock rather than erroring immediately:
    // it started ~250 ms in, so it should have waited a few hundred ms.
    const m = /waited=(\d+)/.exec(rWaiter.stderr);
    expect(m).toBeTruthy();
    const waited = m ? Number(m[1]) : 0;
    expect(waited).toBeGreaterThan(300);
    expect(waited).toBeLessThan(5000);

    // Both writes landed and the DB is intact.
    const check = getDb(dbFile);
    const rows = check.all('SELECT id, v FROM t ORDER BY id', []) as Array<{ id: string; v: string }>;
    expect(rows).toEqual([
      { id: 'a', v: 'holder' },
      { id: 'b', v: 'waiter' },
    ]);
    const integrity = check.get('PRAGMA integrity_check', []) as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    _resetDb();
  }, 30_000);
});
