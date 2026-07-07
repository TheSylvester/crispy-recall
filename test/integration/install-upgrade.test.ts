/**
 * install-upgrade — in-place upgrade of a legacy (wasm / delete-mode / v1) DB.
 *
 * Simulates an existing npm user upgrading in place: a delete-mode,
 * `embed_version = 1` DB (built with the node-sqlite3-wasm devDependency) at a
 * sandboxed RECALL_HOME. Proves `runInstall` snapshots, flips to WAL safely,
 * handles `_stem` corruption, gates the background re-embed, keeps semantic
 * search non-empty during the incomplete migration (transitional scoring), is
 * idempotent, and aborts cleanly on a busy DB — all against a temp fixture,
 * never a live `~/.recall`.
 *
 * RECALL_HOME is set in the PROCESS ENV (not just _setTestRoot) so the detached
 * backfill child resolves the temp DB — a child that native-opened the live DB
 * is the exact corruption this effort prevents.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Database as WasmDatabase } from 'node-sqlite3-wasm';
import { _resetDb } from '../../src/db.js';
import { dbPath, binDir, runDir } from '../../src/paths.js';
import { runInstall } from '../../src/installer/install.js';
import { getBinaryPath, getModelPath } from '../../src/recall/embedder.js';
import { getEmbedVersionStats, searchMessagesSemantic } from '../../src/recall/message-store.js';
import { quantizeToQ8, computeNorm } from '../../src/recall/quantize.js';

// --- A known 8-dim vector shared by the stored (v1) doc and the query. -------
const DOC_F32 = new Float32Array([0.9, 0.1, -0.3, 0.5, 0.2, -0.7, 0.4, 0.05]);
const { q8: DOC_Q8, scale: DOC_SCALE } = quantizeToQ8(DOC_F32);
const DOC_NORM = computeNorm(DOC_F32);
function q8Bytes(q8: Int8Array): Uint8Array {
  return new Uint8Array(q8.buffer, q8.byteOffset, q8.byteLength);
}

// --- Faithful copy of the recall schema (db.ts ensureSchema) so getDb's
//     CREATE ... IF NOT EXISTS are all no-ops over this delete-mode fixture. ---
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_seq INTEGER NOT NULL,
  message_text TEXT NOT NULL, project_id TEXT, created_at INTEGER NOT NULL, message_role TEXT,
  UNIQUE(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_text, content=messages, content_rowid=rowid, tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, message_text) VALUES ('delete', old.rowid, old.message_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, message_text) VALUES ('delete', old.rowid, old.message_text);
  INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab USING fts5vocab(messages_fts, 'row');
CREATE VIRTUAL TABLE IF NOT EXISTS _stem USING fts5(t, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS _stem_vocab USING fts5vocab(_stem, 'row');
CREATE TABLE IF NOT EXISTS message_vectors (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
  embedding_q8 BLOB NOT NULL, norm REAL NOT NULL, quant_scale REAL NOT NULL,
  embed_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ingest_watermark (
  transcript_path TEXT PRIMARY KEY, last_mtime INTEGER NOT NULL, last_size INTEGER NOT NULL, vendor TEXT NOT NULL
);
`;

/**
 * Build a delete-mode, embed_version=1 DB via the wasm devDependency (the
 * pre-upgrade state). Two messages, one v1 vector, seeded `_stem`. When
 * `corrupt` is set, garble `_stem`'s inverted index (integrity_check flags it,
 * drop+recreate fixes it, and CREATE IF NOT EXISTS can NOT self-heal it).
 */
function buildLegacyDb(dbFile: string, opts: { corrupt?: boolean } = {}): void {
  const w = new WasmDatabase(dbFile);
  try {
    w.exec('PRAGMA journal_mode=DELETE');
    w.exec(SCHEMA);
    const ins = `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
    w.run(ins, ['m1', 's1', 0, 'First message about deploying the recall installer to production', 'p1', 1700000000000, 'user']);
    w.run(ins, ['m2', 's1', 1, 'We migrated the sqlite binding to better-sqlite3 for real WAL journaling', 'p1', 1700000001000, 'assistant']);
    w.run(
      `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, ?, ?, 1)`,
      ['m1', q8Bytes(DOC_Q8), DOC_NORM, DOC_SCALE],
    );
    w.run(`INSERT INTO _stem(t) VALUES (?)`, ['deploying installer production']);
    w.run(`INSERT INTO _stem(t) VALUES (?)`, ['migrated sqlite binding wal journaling']);
    if (opts.corrupt) {
      w.run(`UPDATE _stem_data SET block = ? WHERE id = (SELECT MIN(id) FROM _stem_data)`, [new Uint8Array([0, 0, 0, 0])]);
    }
    const jm = w.get('PRAGMA journal_mode') as { journal_mode: string };
    expect(jm.journal_mode).toBe('delete');
  } finally {
    w.close();
  }
}

// --- Sandbox lifecycle -------------------------------------------------------
let sandbox: string;
let claudeDir: string;
let distDir: string;
const prev: Record<string, string | undefined> = {};

function stageEnv(): void {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-upgrade-'));
  const recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  distDir = join(sandbox, 'dist');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(join(recallHome, 'models'), { recursive: true });

  // Harmless dist bundles — the detached backfill child just `node`s recall.js.
  for (const b of ['recall.js', 'stop-hook.js', 'embed-pending.js', 'statusline.js']) writeFileSync(join(distDir, b), 'process.exit(0);\n');

  prev['RECALL_HOME'] = process.env['RECALL_HOME'];
  prev['CLAUDE_CONFIG_DIR'] = process.env['CLAUDE_CONFIG_DIR'];
  prev['CODEX_HOME'] = process.env['CODEX_HOME'];
  process.env['RECALL_HOME'] = recallHome;
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = join(sandbox, '.codex-absent');

  // Pre-stage the offline runtime so preflight + phase 4 are no-ops.
  mkdirSync(dirname(getBinaryPath()), { recursive: true });
  writeFileSync(getBinaryPath(), 'dummy');
  mkdirSync(dirname(getModelPath()), { recursive: true });
  writeFileSync(getModelPath(), 'dummy-model');
}

/** Pre-seed Claude settings with a stale recall Stop hook + a foreign hook. */
function seedClaudeSettings(): void {
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'node /old/.recall/bin/stop-hook.js' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'node /pre/existing.js' }] },
          ],
        },
      },
      null,
      2,
    ),
  );
}

function recallEntries(arr: any[]): any[] {
  return (arr ?? []).filter((e) => e.hooks?.some((h: any) => /stop-hook\.js/.test(h.command) && /recall/.test(h.command)));
}

beforeEach(() => {
  stageEnv();
  _resetDb();
});

afterEach(() => {
  _resetDb();
  for (const k of ['RECALL_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  }
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

const INSTALL = { yes: true, offline: true, gpuDetect: async () => false } as const;

describe('install-upgrade: legacy delete-mode/v1 DB migrates in place', () => {
  it('flips to WAL, preserves data, gates the drain, and keeps semantic search alive', async () => {
    buildLegacyDb(dbPath());
    seedClaudeSettings();

    const res = await runInstall({ ...INSTALL, distDir });
    expect(res.aborted).toBeFalsy();

    // Classified + migrated in place.
    expect(res.migration?.state).toBe('needs-migration');
    expect(res.migration?.integrity).toBe('ok');

    // journal_mode flipped to WAL (read via a fresh readonly connection).
    const chk = new Database(dbPath(), { readonly: true, fileMustExist: true });
    expect(String(chk.pragma('journal_mode', { simple: true }))).toBe('wal');
    // No data loss: both messages + the v1 vector survive the flip.
    expect((chk.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(2);
    expect((chk.prepare('SELECT COUNT(*) AS c FROM message_vectors').get() as { c: number }).c).toBe(1);
    expect(String(chk.pragma('integrity_check', { simple: true }))).toBe('ok');
    chk.close();

    // Rollback snapshot exists inside the temp root (never escapes to ~/.recall).
    expect(res.migration?.snapshotPath).toBeTruthy();
    expect(res.migration!.snapshotPath!.startsWith(dbPath())).toBe(true);
    expect(existsSync(res.migration!.snapshotPath!)).toBe(true);

    // Background re-embed drain launched (coverage < 1: the sole vector is v1).
    expect(res.migration?.drainLaunched).toBe(true);
    expect(res.backfillPid).toBeTypeOf('number');
    expect(existsSync(join(runDir(), 'backfill.pid'))).toBe(true);

    const stats = getEmbedVersionStats();
    expect(stats).toMatchObject({ total: 1, current: 0, stale: 1, coverage: 0 });

    // --- Non-bricking proof: mid-migration semantic search stays non-empty. ---
    // dualPathSearch sets tolerant = coverage < 0.95; here coverage is 0.
    expect(stats.coverage).toBeLessThan(0.95);
    const { q8, scale } = quantizeToQ8(DOC_F32);
    const norm = computeNorm(DOC_F32);
    const tolerant = searchMessagesSemantic(q8, norm, scale, { tolerant: true });
    expect(tolerant.length).toBeGreaterThan(0); // v1 vector scored → not a blackout
    expect(tolerant[0]!.message_id).toBe('m1');
    // Hard filter (default) would exclude the stale-version vector → blackout.
    const hard = searchMessagesSemantic(q8, norm, scale, { tolerant: false });
    expect(hard.length).toBe(0);

    // Stale recall hook was quiesced then re-wired to the staged stop-hook.js;
    // the foreign hook survives.
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const stopRecall = recallEntries(settings.hooks.Stop);
    expect(stopRecall).toHaveLength(1);
    expect(stopRecall[0].hooks[0].command).toContain(join(binDir(), 'stop-hook.js'));
    expect(settings.hooks.Stop.some((e: any) => e.hooks[0].command === 'node /pre/existing.js')).toBe(true);
  }, 30_000);

  it('repairs a malformed _stem index instead of crashing', async () => {
    buildLegacyDb(dbPath(), { corrupt: true });

    const res = await runInstall({ ...INSTALL, distDir });
    expect(res.aborted).toBeFalsy();
    expect(res.migration?.state).toBe('needs-migration');
    expect(res.migration?.integrity).toBe('repaired-stem');

    const chk = new Database(dbPath(), { readonly: true, fileMustExist: true });
    expect(String(chk.pragma('journal_mode', { simple: true }))).toBe('wal');
    expect(String(chk.pragma('integrity_check', { simple: true }))).toBe('ok');
    // Real data untouched by the _stem rebuild.
    expect((chk.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(2);
    expect((chk.prepare('SELECT COUNT(*) AS c FROM message_vectors').get() as { c: number }).c).toBe(1);
    chk.close();

    // _stem is functional again (fts5 self-check passes on the rebuilt table).
    _resetDb();
    const live = new Database(dbPath(), { fileMustExist: true });
    live.pragma('journal_mode'); // touch
    expect(() => live.exec("INSERT INTO _stem(_stem) VALUES('integrity-check')")).not.toThrow();
    live.close();
  }, 30_000);

  it('is idempotent: a second install is a no-op with no duplicate drain', async () => {
    buildLegacyDb(dbPath());
    const first = await runInstall({ ...INSTALL, distDir });
    expect(first.migration?.state).toBe('needs-migration');
    expect(first.migration?.drainLaunched).toBe(true);

    _resetDb();
    // Simulate a still-live drain so the second install must not duplicate it.
    writeFileSync(join(runDir(), 'backfill.pid'), String(process.pid));

    const second = await runInstall({ ...INSTALL, distDir });
    expect(second.aborted).toBeFalsy();
    expect(second.migration?.state).toBe('already-migrated');
    expect(second.migration?.drainLaunched).toBe(false);
    expect(second.backfillPid).toBeUndefined();
    // No-op restage: no new snapshot, no integrity pass.
    expect(second.migration?.snapshotPath).toBeUndefined();
    expect(second.migration?.integrity).toBeUndefined();

    const chk = new Database(dbPath(), { readonly: true, fileMustExist: true });
    expect(String(chk.pragma('journal_mode', { simple: true }))).toBe('wal');
    chk.close();
  }, 30_000);

  it('aborts cleanly (no throw, DB unchanged) when the DB is busy during the flip', async () => {
    buildLegacyDb(dbPath());

    // A concurrent reader holds a SHARED lock — the exclusive WAL flip can't
    // acquire and getDb throws SQLITE_BUSY after busy_timeout.
    const blocker = new Database(dbPath(), { fileMustExist: true });
    blocker.exec('BEGIN');
    blocker.prepare('SELECT * FROM messages').all();

    let res;
    try {
      res = await runInstall({ ...INSTALL, distDir });
    } finally {
      blocker.close();
    }

    expect(res.aborted).toBe(true);
    expect(res.abortReason).toMatch(/Exit all Claude\/Codex sessions/i);
    // Snapshot was still taken (rollback artifact preserved).
    expect(res.migration?.snapshotPath).toBeTruthy();
    expect(existsSync(res.migration!.snapshotPath!)).toBe(true);

    // The DB was NOT half-flipped — still delete-mode, integrity intact.
    const chk = new Database(dbPath(), { readonly: true, fileMustExist: true });
    expect(String(chk.pragma('journal_mode', { simple: true }))).toBe('delete');
    expect(String(chk.pragma('integrity_check', { simple: true }))).toBe('ok');
    chk.close();
  }, 30_000);
});
