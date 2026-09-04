/**
 * `recall install` must not die at teardown after the codex re-key (R-01y2w6).
 *
 * Measured on the live 0.3.1 hub: every phase succeeded, then the process took
 * SIGBUS (exit 135). In WAL mode SQLite keeps `<db>-shm` `mmap`'d; the
 * detached `recall backfill` child spawned by phase 8 reset the wal-index with
 * `ftruncate(<shm fd>, 3)` while the installer still mapped the old 32 KB
 * region, and the installer's next read (the final coverage query) faulted
 * with BUS_ADRERR.
 *
 * The fault itself needs the real ~1 GB database and a two-process race, so it
 * is not reproducible here. These cases pin the two halves of the fix instead:
 * the connection IS released before a child is spawned, and a spawned
 * `dist/recall.js install --yes` on a seeded un-migrated root exits 0 with NO
 * signal.
 *
 * Tests never touch the live root. `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`; a child that
 * inherits the parent env resolves `recallRoot()` to the live `~/.recall`
 * (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _isDbOpen, _resetDb, getDb, closeDbBeforeChildSpawn, RETRIEVAL_SCHEMA_DDL } from '../../src/db.js';
import { CODEX_REKEY_KEY } from '../../src/installer/codex-rekey-migration.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');

const A = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

let recallHome: string;
let codexHome: string;
let claudeDir: string;
let remoteRoot: string;
let restoreRoot: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

function legacyId(sid: string, n: number): string {
  return `codex-jsonl-${sid.slice(0, 8)}-${n}`;
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RECALL_HOME: recallHome,
    RECALL_REMOTE_ROOT: remoteRoot,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
  };
}

/** A 0.3.1-generation DB: current DDL + retrieval marker, NO codex marker. */
function buildFixture(): void {
  const dir = join(codexHome, 'sessions', '2026', '09', '04');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-09-04T00-00-00-${A}.jsonl`), [
    JSON.stringify({ timestamp: '2026-09-04T00:00:00.000Z', type: 'session_meta', payload: { id: A, cwd: '/proj' } }),
    JSON.stringify({ timestamp: '2026-09-04T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `alpha heron answer${PAD}` }] } }),
  ].join('\n') + '\n');

  const raw = new Database(dbPath());
  raw.pragma('journal_mode = WAL');
  raw.exec(RETRIEVAL_SCHEMA_DDL.tables);
  raw.exec(RETRIEVAL_SCHEMA_DDL.fts);
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS _stem USING fts5(t, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS _stem_vocab USING fts5vocab(_stem, 'row');
    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
      embedding_q8 BLOB NOT NULL, norm REAL NOT NULL, quant_scale REAL NOT NULL,
      embed_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ingest_watermark (
      transcript_path TEXT PRIMARY KEY, last_mtime INTEGER NOT NULL,
      last_size INTEGER NOT NULL, vendor TEXT NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
     VALUES (?, ?, 0, ?, '/proj', 1000, 'assistant', 'hot')`,
  ).run(legacyId(A, 0), A, `alpha heron answer${PAD}`);
  raw.prepare(
    `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
  ).run(legacyId(A, 0), Buffer.alloc(768, 1), EMBED_VERSION);
  raw.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('retrieval_class_migration', 'complete')`).run();
  raw.close();
}

/** Kill whatever detached drain the install left behind. */
function killDrain(): void {
  try {
    const pid = Number(readFileSync(join(recallHome, 'run', 'backfill.pid'), 'utf-8').trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch { /* no drain, or already gone */ }
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-drain-spawn-${randomUUID()}`);
  codexHome = join(recallHome, 'codex');
  claudeDir = join(recallHome, 'claude');
  remoteRoot = join(recallHome, 'remote');
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(join(recallHome, 'models'), { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['RECALL_HOME', 'RECALL_REMOTE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) prevEnv[k] = process.env[k];
  process.env['RECALL_HOME'] = recallHome;
  process.env['RECALL_REMOTE_ROOT'] = remoteRoot;
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = codexHome;
  // Offline runtime: stubs so the install downloads nothing and probes CPU.
  writeFileSync(join(recallHome, 'bin', 'llama-embedding'), 'dummy');
  writeFileSync(join(recallHome, 'models', 'nomic-embed-text-v1.5.Q8_0.gguf'), 'dummy-model');
  _resetDb();
  buildFixture();
});

afterEach(() => {
  killDrain();
  restoreRoot?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('install: no live DB handle across a child spawn', () => {
  it('is isolated: dbPath() points inside the temp root, never the live ~/.recall', () => {
    expect(resolve(dbPath()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(dbPath()).startsWith(resolve(recallHome))).toBe(true);
  });

  it('closeDbBeforeChildSpawn releases the handle AND its wal-index mapping', () => {
    const first = getDb(dbPath(), { allowPendingMigration: true });
    expect(first.get('SELECT 1 AS x')).toEqual({ x: 1 });
    expect(existsSync(`${dbPath()}-shm`)).toBe(true);

    closeDbBeforeChildSpawn();

    // The old handle is genuinely closed — a child may now reset the wal-index
    // without faulting this process.
    expect(() => first.get('SELECT 1 AS x')).toThrow();
    expect(existsSync(`${dbPath()}-shm`)).toBe(false);

    // And a later caller transparently gets a fresh connection.
    const second = getDb(dbPath(), { allowPendingMigration: true });
    expect(second).not.toBe(first);
    expect(second.get('SELECT 1 AS x')).toEqual({ x: 1 });
  });

  it('runInstall holds NO open connection once the detached drain is spawned', async () => {
    // The exact defect: the installer kept its connection (and its `-shm`
    // mapping) live across `spawnDetachedBackfill()`, then read coverage from
    // it. Assert the invariant directly — this fails without the phase-8 close.
    const { runInstall } = await import('../../src/installer/install.js');
    const distDir = join(recallHome, 'stub-dist');
    mkdirSync(distDir, { recursive: true });
    for (const f of ['recall.js', 'stop-hook.js', 'embed-pending.js', 'statusline.js', 'push-pending.js']) {
      writeFileSync(join(distDir, f), 'process.exit(0);\n');
    }

    const res = await runInstall({
      yes: true, offline: true, gpuDetect: async () => false, noClaudemd: true, distDir,
    });
    expect(res.aborted).toBeFalsy();
    // The re-key ran and dropped vectors, so phase 8 took the SPAWN branch.
    expect(res.migration?.codexRekey?.performed).toBe(true);
    expect(res.migration!.drainLaunched).toBe(true);
    expect(_isDbOpen()).toBe(false);
  }, 240_000);

  it('a spawned `install --yes` over the codex re-key exits 0 with NO signal', () => {
    if (!existsSync(CLI_BUNDLE)) throw new Error('dist/recall.js missing — run `npm run build` first');
    const r = spawnSync(
      process.execPath,
      [CLI_BUNDLE, 'install', '--yes', '--offline', '--no-claudemd'],
      { env: childEnv(), encoding: 'utf-8', timeout: 180_000 },
    );
    // SIGBUS surfaced as signal 'SIGBUS' / status null — assert BOTH.
    expect(r.signal, `stderr: ${r.stderr}`).toBeNull();
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    // The migration really ran on this root (the crashing path).
    const raw = new Database(dbPath(), { readonly: true, fileMustExist: true });
    try {
      const marker = raw.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(CODEX_REKEY_KEY) as { value?: string } | undefined;
      expect(marker?.value).toBe('complete');
    } finally {
      raw.close();
    }
  }, 240_000);
});
