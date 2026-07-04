#!/usr/bin/env node
/**
 * spike-E — corruption-mechanism repro (DOCUMENTATION-GRADE, NOT A CI TEST).
 *
 * This is the executable proof of WHY ~170 lines of `.lock`/`.owner` machinery
 * were deleted from src/db.ts in the better-sqlite3 migration. It reproduces the
 * pre-migration failure mode on the OLD binding (node-sqlite3-wasm), so it is
 * intentionally NOT named `*.test.ts` and is NOT collected by vitest — run it by
 * hand:
 *
 *     node test/spike/wal-corruption-mechanism.mjs
 *
 * The mechanism (design doc §1 "structural race", §2 spike E):
 *   node-sqlite3-wasm's only cross-process lock is a `mkdir ${db}.lock` dir. The
 *   deleted machinery tried to remove only a *dead* owner's lock, but its shared
 *   `${db}.owner` file records the *last opener*, not the *lock holder*, so a
 *   routine interleaving makes `clearStaleLock` remove a LIVE lock. Once a live
 *   lock is removed, a second writer proceeds concurrently with the first under
 *   delete-mode (no real WAL, no real locking) → torn pages / cross-linked
 *   B-tree pages / "rowid out of order" — the June-2026 signature. Both writers
 *   report success; the damage is silent.
 *
 * Here a "saboteur" loop removes `${db}.lock` the instant it appears, standing
 * in for a single `clearStaleLock` misfire. Corruption is probabilistic (the
 * spike hit it on attempt 1); this runs several attempts and stops on the first
 * malformation. A clean run across all attempts does not disprove the race — it
 * just did not win the timing this time.
 *
 * better-sqlite3 + real WAL removes the whole class: there is no app-level lock
 * to misremove, readers never block writers, and a WAL DB fails CLOSED against
 * any stale wasm process (see test/integration/wal-fence.test.ts).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATTEMPTS = 8;

const WRITER_CODE = `
const { Database } = require('node-sqlite3-wasm');
const db = new Database(process.env.SPIKE_DB);
db.exec('PRAGMA busy_timeout = 150');   // low timeout to maximize contention
db.exec('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
const ins = db.prepare('INSERT OR REPLACE INTO t(id, a, b) VALUES (?, ?, ?)');
const base = +process.env.SPIKE_BASE;
for (let round = 0; round < 60; round++) {
  try {
    db.exec('BEGIN');
    for (let i = 0; i < 200; i++) ins.run([(base + i) % 500, 'a'.repeat(80), 'b'.repeat(80)]);
    db.exec('COMMIT');
  } catch { try { db.exec('ROLLBACK'); } catch {} }
}
ins.finalize();
db.close();
`;

function spawnWriter(dbFile, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', WRITER_CODE], {
      cwd: ROOT,
      env: { ...process.env, SPIKE_DB: dbFile, SPIKE_BASE: String(base) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** Aggressively remove the wasm `.lock` dir the instant it appears. */
function startSaboteur(dbFile) {
  const lockDir = `${dbFile}.lock`;
  let running = true;
  (function loop() {
    if (!running) return;
    try { if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true }); } catch {}
    setImmediate(loop);
  })();
  return () => { running = false; };
}

const nodeRequire = createRequire(import.meta.url);

function integrityCheck(dbFile) {
  // Read integrity via better-sqlite3 (native, honest) so a malformation the
  // wasm writers left behind is reported rather than hidden by fail-closed.
  const Database = nodeRequire('better-sqlite3');
  try {
    const db = new Database(dbFile, { readonly: true });
    const quick = db.pragma('quick_check', { simple: true });
    const full = db.pragma('integrity_check', { simple: true });
    db.close();
    return { quick: String(quick), full: String(full) };
  } catch (e) {
    return { quick: 'ERROR', full: String(e && e.message) };
  }
}

console.log(`spike-E: reproducing the wasm live-lock-removal corruption mechanism (${ATTEMPTS} attempts)\n`);

let corruptedAt = -1;
for (let attempt = 1; attempt <= ATTEMPTS && corruptedAt < 0; attempt++) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-spikeE-'));
  const dbFile = join(dir, 'recall.db');
  const stopSaboteur = startSaboteur(dbFile);
  const [w1, w2] = await Promise.all([spawnWriter(dbFile, 0), spawnWriter(dbFile, 250)]);
  stopSaboteur();

  const integrity = integrityCheck(dbFile);
  const ok = integrity.quick === 'ok' && integrity.full === 'ok';
  console.log(
    `attempt ${attempt}: writers exited ${w1.code}/${w2.code} — ` +
      `quick_check=${integrity.quick.slice(0, 60)} integrity_check=${integrity.full.slice(0, 60)}` +
      `${ok ? '' : '   <<< CORRUPTED (both writers reported success)'}`,
  );
  if (!ok) corruptedAt = attempt;
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (corruptedAt > 0) {
  console.log(`RESULT: silent corruption reproduced on attempt ${corruptedAt}.`);
  console.log('This is exactly the failure class the WAL migration removes — see');
  console.log('test/integration/wal-storm.test.ts (native WAL: zero locks, integrity ok).');
} else {
  console.log('RESULT: no corruption this run (timing-dependent). Re-run to try again —');
  console.log('a clean run does not disprove the race; spike E hit it on attempt 1.');
}
