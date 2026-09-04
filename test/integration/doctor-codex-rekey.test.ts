/**
 * `recall doctor` — Codex re-key reporting (spec §5).
 *
 * Asserts on the JSON/`BindingHealth`, never on the exit code: that code also
 * carries preflight failures and the staged-binding marker, and
 * `checkBindingHealth` early-returns when `<RECALL_HOME>/bin/recall.js` is
 * absent (doctor.ts:130-135).
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit `env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }`; a child that inherits the parent env resolves
 * `recallRoot()` to the live `~/.recall` (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb, RETRIEVAL_SCHEMA_DDL } from '../../src/db.js';
import { checkBindingHealth } from '../../src/installer/doctor.js';
import { runCodexRekeyMigration } from '../../src/installer/codex-rekey-migration.js';
import { getEmbeddingGapStats } from '../../src/recall/message-store.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

const A = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63'; // rollout on disk → re-keyed
const D = '33333333-4444-5555-6666-777777777777'; // transcript gone → stays legacy
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

function rolloutPath(): string {
  const dir = join(codexHome, 'sessions', '2026', '09', '04');
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-09-04T00-00-00-${A}.jsonl`);
}

function buildFixture(): void {
  writeFileSync(rolloutPath(), [
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
  raw.prepare(
    `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
  ).run(legacyId(D, 0), Buffer.alloc(768, 1), EMBED_VERSION);
  raw.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('retrieval_class_migration', 'complete')`).run();
  raw.close();
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-doctor-rekey-${randomUUID()}`);
  codexHome = join(recallHome, 'codex');
  claudeDir = join(recallHome, 'claude');
  remoteRoot = join(recallHome, 'remote');
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['RECALL_HOME', 'RECALL_REMOTE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) prevEnv[k] = process.env[k];
  process.env['RECALL_HOME'] = recallHome;
  process.env['RECALL_REMOTE_ROOT'] = remoteRoot;
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = codexHome;
  // checkBindingHealth early-returns without a staged bundle.
  writeFileSync(join(recallHome, 'bin', 'recall.js'), 'process.exit(0);\n');
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

describe.skipIf(platform() === 'win32')('doctor: codex re-key + drain gap', () => {
  it('reports the pending migration, then the residue and the drain gap it opened', async () => {
    const before = checkBindingHealth();
    expect(before.codexRekeyPending).toBe(true);
    expect(before.problems.some((p) => /codex message-id migration pending/.test(p))).toBe(true);
    expect(before.legacyCodexSessions).toBeNull(); // not counted while pending
    const gapBefore = before.embedGap;
    expect(gapBefore).toBe(0);

    await runCodexRekeyMigration({ log: () => {} });
    _resetDb();

    const after = checkBindingHealth();
    expect(after.codexRekeyPending).toBe(false);
    expect(after.legacyCodexSessions).toBe(1); // session D — transcript gone
    expect(after.embedGap).toBeGreaterThan(0);
    expect(after.problems.some((p) => /codex message-id/.test(p))).toBe(false);
    // embedCoverage cannot serve as the drain signal: the purge left it at 1.
    expect(after.embedCoverage).toBe(1);

    // The non-JSON report names both lines.
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); });
    try {
      const { runDoctor } = await import('../../src/installer/doctor.js');
      await runDoctor({ offline: true });
    } finally {
      spy.mockRestore();
    }
    const out = printed.join('\n');
    expect(out).toMatch(/Legacy codex ids: 1 sessions/);
    expect(out).toMatch(/Embed gap:\s+\d+ messages awaiting vectors — run: recall backfill --auto-embed/);

    // One drain closes the gap again.
    _resetDb();
    getDb(dbPath());
    const raw = new Database(dbPath());
    try {
      const rows = raw.prepare(
        `SELECT message_id FROM messages m WHERE m.retrieval_class = 'hot'
           AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id = m.message_id)`,
      ).all() as Array<{ message_id: string }>;
      const ins = raw.prepare(
        `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
      );
      for (const r of rows) ins.run(r.message_id, Buffer.alloc(768, 1), EMBED_VERSION);
    } finally {
      raw.close();
    }
    _resetDb();
    expect(checkBindingHealth().embedGap).toBe(gapBefore);
    expect(getEmbeddingGapStats().gapCount).toBe(0);
  }, 60_000);
});
