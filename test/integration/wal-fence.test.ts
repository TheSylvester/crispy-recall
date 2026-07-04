/**
 * WAL fence — node-sqlite3-wasm fails CLOSED on a WAL database.
 *
 * This locks in the empirically-proven behavior (design doc §2 spike D) that
 * makes the one-time live conversion safe: once a DB is flipped to WAL, the old
 * wasm binding — whose VFS declares no shared-memory (xShm*) methods — can
 * neither open nor operate on it, and CANNOT corrupt it. The WAL header is a
 * hard fence against every stale wasm-era process.
 *
 * The complement (real WAL + multi-process safety) is proven by wal-storm and
 * wal-busy-contention; this test proves the *fence* direction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database as WasmDatabase } from 'node-sqlite3-wasm';
import { getDb, _resetDb } from '../../src/db.js';

describe('WAL fence: node-sqlite3-wasm fails closed on a WAL DB', () => {
  let dir: string;

  afterEach(() => {
    _resetDb();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('opens but cannot operate on a WAL DB, and never corrupts it', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-fence-'));
    const dbFile = join(dir, 'recall.db');

    // 1. Build a WAL fixture through the real driver. getDb asserts
    //    journal_mode === 'wal' on open, so the fixture is provably WAL.
    const db = getDb(dbFile);
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t(id, v) VALUES (?, ?)', [1, 'wal-fixture']);
    _resetDb();

    // 2. node-sqlite3-wasm must FAIL CLOSED on a WAL DB: the open may "succeed"
    //    but any statement errors (upstream issue #105: "unable to open database
    //    file"). Either failure mode is acceptable — what matters is that it
    //    cannot successfully read or write, and cannot corrupt.
    let failedClosed = false;
    let wasm: WasmDatabase | undefined;
    try {
      wasm = new WasmDatabase(dbFile);
      wasm.all('SELECT * FROM t');
    } catch {
      failedClosed = true;
    } finally {
      try {
        wasm?.close();
      } catch {
        /* ignore */
      }
    }
    expect(failedClosed).toBe(true);

    // 3. The WAL DB is intact — integrity clean and data readable by the native
    //    driver. (getDb's one-time hygiene removes any transient wasm `.lock`.)
    const after = getDb(dbFile);
    const integrity = after.get('PRAGMA integrity_check', []) as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    const row = after.get('SELECT v FROM t WHERE id = ?', [1]) as { v: string };
    expect(row.v).toBe('wal-fixture');
    _resetDb();
  });
});
