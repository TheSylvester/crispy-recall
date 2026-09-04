/**
 * `recall repair --rekey-codex` through the shipped bundle (spec §5).
 *
 * Proves the attended CLI door: it runs the migration, prints the summary
 * line, writes the marker, and — with no staged `embed-pending.js` — prints the
 * backfill instruction instead of spawning a drain. The no-flag form still
 * refuses, now naming the new flag.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit `env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }`; a child that inherits the parent env resolves
 * `recallRoot()` to the live `~/.recall` (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, RETRIEVAL_SCHEMA_DDL } from '../../src/db.js';
import { CODEX_REKEY_KEY } from '../../src/installer/codex-rekey-migration.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');

const A = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const D = '33333333-4444-5555-6666-777777777777';
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
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
     VALUES (?, ?, 0, ?, '/proj', 1001, 'assistant', 'hot')`,
  ).run(legacyId(D, 0), D, `delta osprey answer${PAD}`);
  raw.prepare(
    `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
  ).run(legacyId(A, 0), Buffer.alloc(768, 1), EMBED_VERSION);
  raw.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('retrieval_class_migration', 'complete')`).run();
  raw.close();
}

function markerValue(): string | undefined {
  const raw = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(CODEX_REKEY_KEY) as { value?: string } | undefined)?.value;
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-repair-rekey-${randomUUID()}`);
  codexHome = join(recallHome, 'codex');
  claudeDir = join(recallHome, 'claude');
  remoteRoot = join(recallHome, 'remote');
  mkdirSync(recallHome, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['RECALL_HOME', 'RECALL_REMOTE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) prevEnv[k] = process.env[k];
  process.env['RECALL_HOME'] = recallHome;
  process.env['RECALL_REMOTE_ROOT'] = remoteRoot;
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = codexHome;
  _resetDb();
  buildFixture();
});

afterEach(() => {
  restoreRoot?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('recall repair --rekey-codex (CLI)', () => {
  it('runs the migration, prints the summary, writes the marker, and asks for a drain', () => {
    if (!existsSync(CLI_BUNDLE)) throw new Error('dist/recall.js missing — run `npm run build` first');
    const r = spawnSync(process.execPath, [CLI_BUNDLE, 'repair', '--rekey-codex'], {
      env: childEnv(), encoding: 'utf-8', timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /codex re-key: 2 sessions, 1 re-ingested, 1 transcripts gone, \d+ vectors dropped/,
    );
    // No embed-pending.js is staged under <RECALL_HOME>/bin → instruction, not a spawn.
    expect(r.stdout).toMatch(/run: recall backfill --auto-embed to re-embed the dropped vectors/);
    expect(markerValue()).toBe('complete');
  }, 90_000);

  it('`recall repair` with no flag exits 1 and names every mode', () => {
    if (!existsSync(CLI_BUNDLE)) throw new Error('dist/recall.js missing — run `npm run build` first');
    const r = spawnSync(process.execPath, [CLI_BUNDLE, 'repair'], {
      env: childEnv(), encoding: 'utf-8', timeout: 30_000,
    });
    expect(r.status).toBe(1);
    for (const flag of ['--fts', '--vectors', '--full', '--rekey-codex']) {
      expect(r.stderr, flag).toContain(flag);
    }
  }, 60_000);
});
