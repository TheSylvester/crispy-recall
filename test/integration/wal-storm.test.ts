/**
 * WAL multi-process storm (port of design doc §2 spike B).
 *
 * The test the wasm binding could never pass honestly: several real writer
 * processes plus a reader hammer the same DB with overlapping batched
 * `INSERT OR REPLACE` and assert ZERO `database is locked`, a clean
 * `integrity_check`, and every row present. Under WAL + busy_timeout +
 * `BEGIN IMMEDIATE`, this is SQLite's designed-for same-host configuration.
 *
 * The old suite (stop-hook.test.ts, wasm era) had to *document* that concurrent
 * hook writes may be dropped; this asserts they are not.
 *
 * Child writers/reader run as `node -e` with cwd=repo root so their
 * `require('better-sqlite3')` resolves the repo's addon (a child in a bare temp
 * dir could not). FK is ON and message_vectors.message_id REFERENCES messages,
 * so the parent rows are seeded first (via the real ensureSchema, not a
 * hand-rolled subset) — otherwise the vector inserts would fail with a
 * foreign-key error, not a lock error, and prove nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, _resetDb } from '../../src/db.js';

const ROOT = join(__dirname, '..', '..');

/** Total distinct message rows every writer contends over (full overlap). */
const N = 1200;
const BATCH = 100;
const WRITERS = 3;

const WRITER_CODE = `
const Database = require('better-sqlite3');
const db = new Database(process.env.STORM_DB);
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const N = +process.env.STORM_N, BATCH = +process.env.STORM_BATCH;
const tag = +process.env.STORM_TAG;
const buf = Buffer.alloc(64, tag & 0xff);
const ins = db.prepare(
  'INSERT OR REPLACE INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?,?,?,?,?)'
);
for (let b = 0; b < N; b += BATCH) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = b; i < Math.min(b + BATCH, N); i++) ins.run('m' + i, buf, 1.0, 0.01, 3);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
db.close();
process.exit(0);
`;

const READER_CODE = `
const Database = require('better-sqlite3');
const db = new Database(process.env.STORM_DB, { readonly: true });
db.pragma('busy_timeout = 5000');
const cntV = db.prepare('SELECT COUNT(*) AS n FROM message_vectors');
const someM = db.prepare('SELECT message_id FROM messages LIMIT 20');
for (let r = 0; r < 200; r++) { cntV.get(); someM.all(); }
db.close();
process.exit(0);
`;

interface ChildResult {
  exitCode: number | null;
  stderr: string;
}

function runChild(code: string, tag: number, env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: ROOT,
      env: { ...env, STORM_TAG: String(tag) },
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

describe('WAL multi-process write storm', () => {
  let dir: string;

  afterEach(() => {
    _resetDb();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('3 writers + 1 reader: zero lock errors, integrity ok, all rows present', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-storm-'));
    const dbFile = join(dir, 'recall.db');

    // Seed parent messages m0..m(N-1) via the REAL schema (FK targets), then
    // release the connection so the children own the writes.
    const seed = getDb(dbFile);
    seed.exec('BEGIN IMMEDIATE');
    try {
      const ins = seed.prepare(
        `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < N; i++) {
        ins.run([`m${i}`, 'storm-sess', i, `storm message ${i} with enough text to matter`, '/tmp/storm', Date.UTC(2026, 0, 1, 0, 0, 0) + i, i % 2 === 0 ? 'user' : 'assistant']);
      }
      seed.exec('COMMIT');
    } catch (e) {
      seed.exec('ROLLBACK');
      throw e;
    }
    _resetDb();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STORM_DB: dbFile,
      STORM_N: String(N),
      STORM_BATCH: String(BATCH),
    };

    // Fire all writers + reader concurrently.
    const jobs: Promise<ChildResult>[] = [];
    for (let w = 0; w < WRITERS; w++) jobs.push(runChild(WRITER_CODE, w + 1, env));
    jobs.push(runChild(READER_CODE, 0, env));
    const results = await Promise.all(jobs);

    // Every child exits 0, and NO lock/busy error escapes to stderr.
    for (const r of results) {
      if (r.exitCode !== 0) {
        // Surface the failure for debugging before the assertion.
        console.error('storm child failed:', r.exitCode, r.stderr);
      }
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/database is locked/i);
      expect(r.stderr).not.toMatch(/SQLITE_BUSY/i);
    }

    // Post-storm: clean integrity + exactly N vectors (INSERT OR REPLACE dedups
    // to the PK), all FK-valid.
    const check = getDb(dbFile);
    const integrity = check.get('PRAGMA integrity_check', []) as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    const fk = check.all('PRAGMA foreign_key_check', []) as unknown[];
    expect(fk.length).toBe(0);
    const count = check.get('SELECT COUNT(*) AS n FROM message_vectors', []) as { n: number };
    expect(count.n).toBe(N);
    _resetDb();
  }, 60_000);
});
