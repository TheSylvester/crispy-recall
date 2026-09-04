/**
 * project_key schema (spec §4.2) — the column, the index, and the `fresh` guard.
 *
 * The 0.3.1 new-generation DDL is copied INLINE below, verbatim as it read at
 * 51d28f0 with `project_key` and `idx_messages_project_key` omitted. It is not
 * imported from db.ts on purpose: the live constant now carries the column, so
 * importing it would prove nothing about an upgrade.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb, PROJECT_KEY_BACKFILL_KEY } from '../../src/db.js';
import { runRetrievalClassMigration } from '../../src/installer/retrieval-class-migration.js';
import { clearProjectKeyCache } from '../../src/recall/project-key.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');

// ---------------------------------------------------------------------------
// The 0.3.1 (51d28f0) DDL, verbatim, MINUS project_key and its index.
// ---------------------------------------------------------------------------
const TABLES_0_3_1 = `
    CREATE TABLE IF NOT EXISTS messages (
      message_id      TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      message_seq     INTEGER NOT NULL,
      message_text    TEXT NOT NULL,
      project_id      TEXT,
      created_at      INTEGER NOT NULL,
      message_role    TEXT,
      retrieval_class TEXT NOT NULL DEFAULT 'hot',
      UNIQUE(session_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
    -- getUnembeddedMessages() orders the whole table by created_at DESC (LIMIT N).
    -- Without a standalone created_at index SQLite full-scans messages and builds
    -- a TEMP B-TREE to sort on every call — a ~4s/batch cost that dominates the
    -- embed drain and every Stop-hook catch-up. This index serves the ORDER BY so
    -- the planner walks it and early-terminates at LIMIT instead.
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

    -- session_provenance — durable per-session classification evidence:
    -- canonical id, vendor, root-vs-agent kind, parent thread, hook/agent
    -- metadata, and the transcript path → canonical id mapping that lets
    -- later T1/mtime scans resolve a child to ONE identity.
    CREATE TABLE IF NOT EXISTS session_provenance (
      session_id        TEXT PRIMARY KEY,
      vendor            TEXT NOT NULL,
      kind              TEXT NOT NULL,
      parent_session_id TEXT,
      agent_depth       INTEGER,
      agent_meta        TEXT,
      transcript_path   TEXT,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provenance_path ON session_provenance(transcript_path);

    -- session_aliases — alternate identifiers (e.g. a hook agent_id that
    -- differs from the child rollout's session-meta UUID) → canonical id.
    CREATE TABLE IF NOT EXISTS session_aliases (
      alias_id   TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source     TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

const FTS_0_3_1 = `
    -- Filtered external-content source: FTS5 rebuild/integrity-check read
    -- THIS view, so 'rebuild' repopulates only hot rows and the (rank-1)
    -- integrity check compares against the filtered corpus.
    CREATE VIEW IF NOT EXISTS searchable_messages AS
      SELECT rowid, message_text FROM messages WHERE retrieval_class = 'hot';

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_text,
      content=searchable_messages,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );

    -- Four-state trigger behavior:
    --   insert hot → add        | insert agent → no-op
    --   delete hot → delete     | delete agent → no-op
    --   update hot→hot → delete old + add new
    --   update hot→agent → delete old only
    --   update agent→hot → add new only
    --   update agent→agent → no-op
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
      WHEN new.retrieval_class = 'hot'
    BEGIN
      INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
      WHEN old.retrieval_class = 'hot'
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message_text)
      VALUES ('delete', old.rowid, old.message_text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message_text)
        SELECT 'delete', old.rowid, old.message_text WHERE old.retrieval_class = 'hot';
      INSERT INTO messages_fts(rowid, message_text)
        SELECT new.rowid, new.message_text WHERE new.retrieval_class = 'hot';
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab
      USING fts5vocab(messages_fts, 'row');
  `;

/** The EXACT pre-change (0.2.2) schema, copied from
 *  test/integration/retrieval-class-migration.test.ts:44-98 (its only fixture). */
const OLD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    message_id    TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    message_seq   INTEGER NOT NULL,
    message_text  TEXT NOT NULL,
    project_id    TEXT,
    created_at    INTEGER NOT NULL,
    message_role  TEXT,
    UNIQUE(session_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_text,
    content=messages,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, message_text)
    VALUES ('delete', old.rowid, old.message_text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, message_text)
    VALUES ('delete', old.rowid, old.message_text);
    INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
  END;
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab USING fts5vocab(messages_fts, 'row');

  CREATE VIRTUAL TABLE IF NOT EXISTS _stem USING fts5(t, tokenize='porter unicode61');
  CREATE VIRTUAL TABLE IF NOT EXISTS _stem_vocab USING fts5vocab(_stem, 'row');

  CREATE TABLE IF NOT EXISTS message_vectors (
    message_id    TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
    embedding_q8  BLOB NOT NULL,
    norm          REAL NOT NULL,
    quant_scale   REAL NOT NULL,
    embed_version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ingest_watermark (
    transcript_path TEXT PRIMARY KEY,
    last_mtime      INTEGER NOT NULL,
    last_size       INTEGER NOT NULL,
    vendor          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_watermark_vendor ON ingest_watermark(vendor);
`;

const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

let recallHome: string;
let restoreRoot: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

/** Seed a 0.3.1 new-generation DB WITHOUT project_key (the upgrade fixture). */
function seedNewGeneration(): void {
  const raw = new Database(dbPath());
  raw.pragma('journal_mode = WAL');
  raw.exec(TABLES_0_3_1);
  raw.exec(FTS_0_3_1);
  raw.exec(`INSERT INTO schema_meta(key, value) VALUES('retrieval_class_migration','complete')`);
  const ins = raw.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'hot')`,
  );
  ins.run('m-old-0', 's-old', 0, `pre-existing narwhal narration${PAD}`, '/x/one', 1000, 'user');
  ins.run('m-old-1', 's-old', 1, `pre-existing narwhal reply${PAD}`, '/x/one', 1001, 'assistant');
  raw.close();
}

/** Seed the OLD-generation (0.2.2) fixture the retrieval-class migration owns. */
function seedOldGeneration(): void {
  const raw = new Database(dbPath());
  raw.pragma('journal_mode = WAL');
  raw.exec(OLD_SCHEMA);
  const ins = raw.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  );
  ins.run('m-0.2.2-0', '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63', 0, `legacy heron prompt${PAD}`, 1000, 'user');
  raw.close();
}

function columns(): string[] {
  return (getDb(dbPath()).all(`PRAGMA table_info(messages)`) as Array<{ name: string }>)
    .map((c) => c.name);
}

function indexNames(): string[] {
  return (getDb(dbPath()).all(
    `SELECT name FROM sqlite_master WHERE type='index'`,
  ) as Array<{ name: string }>).map((r) => r.name);
}

function marker(): string | undefined {
  const row = getDb(dbPath()).get(
    `SELECT value FROM schema_meta WHERE key = ?`, [PROJECT_KEY_BACKFILL_KEY],
  ) as { value?: string } | undefined;
  return row?.value;
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-pkey-schema-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_HOME', 'RECALL_REMOTE_ROOT']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = join(recallHome, 'claude');
  process.env['CODEX_HOME'] = join(recallHome, 'codex');
  process.env['RECALL_REMOTE_ROOT'] = join(recallHome, 'remote');
  clearProjectKeyCache();
  _resetDb();
});

afterEach(() => {
  restoreRoot?.(); restoreRoot = undefined;
  _resetDb();
  clearProjectKeyCache();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('ensureSchema adds project_key', () => {
  it('a pre-existing 0.3.1 DB gains the column and the index on a normal open', () => {
    seedNewGeneration();
    _resetDb();
    expect(columns()).toContain('project_key');
    expect(indexNames()).toContain('idx_messages_project_key');
    // Existing rows survive untouched, keyed NULL.
    const rows = getDb(dbPath()).all(
      `SELECT message_id, project_key FROM messages ORDER BY message_id`,
    ) as Array<{ message_id: string; project_key: string | null }>;
    expect(rows).toEqual([
      { message_id: 'm-old-0', project_key: null },
      { message_id: 'm-old-1', project_key: null },
    ]);
  });

  it('a concurrent second open (spawned CLI) succeeds while the parent holds the connection', () => {
    seedNewGeneration();
    _resetDb();
    getDb(dbPath()); // parent holds it open across the child's whole run

    const child = spawnSync(process.execPath, [CLI_BUNDLE, '--list', '--no-catchup'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RECALL_HOME: recallHome,
        RECALL_REMOTE_ROOT: join(recallHome, 'remote'),
        CLAUDE_CONFIG_DIR: join(recallHome, 'claude'),
        CODEX_HOME: join(recallHome, 'codex'),
        RECALL_LOG_LEVEL: 'error',
      },
    });
    expect(child.status, child.stderr).toBe(0);
  });

  it('the `fresh` guard: a brand-new DB is marked complete, a pre-existing one is NOT', () => {
    // Fresh: nothing to re-key, so the marker is free.
    getDb(dbPath());
    expect(marker()).toBe('complete');

    // Pre-existing: column + index appear, marker stays absent until the
    // attended `recall repair --rekey-projects` writes it.
    _resetDb();
    rmSync(dbPath(), { force: true });
    rmSync(dbPath() + '-wal', { force: true });
    rmSync(dbPath() + '-shm', { force: true });
    seedNewGeneration();
    _resetDb();
    expect(columns()).toContain('project_key');
    expect(indexNames()).toContain('idx_messages_project_key');
    expect(marker()).toBeUndefined();
  });

  it('the retrieval-class migration still completes; the next normal open adds the column', async () => {
    seedOldGeneration();
    _resetDb();
    const res = await runRetrievalClassMigration();
    expect(res.performed).toBe(true);

    _resetDb();
    expect(columns()).toContain('project_key');
    expect(indexNames()).toContain('idx_messages_project_key');
    // Migrated (not fresh) → the backfill marker must NOT be claimed.
    expect(marker()).toBeUndefined();
  });
});

describe.skipIf(platform() === 'win32')('idx_messages_project_key is used', () => {
  it('the bare OR predicate plans a MULTI-INDEX OR naming the index; without it, a scan', () => {
    getDb(dbPath());
    const d = getDb(dbPath());
    d.run(
      `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class, project_key)
       VALUES ('p0','s0',0,?, '/x/one', 1000, 'user', 'hot', 'git:aaaa')`,
      [`plan fixture row${PAD}`],
    );

    const sql = `SELECT message_id FROM messages WHERE project_key = ? OR project_id = ?`;
    const plan = (d.all(`EXPLAIN QUERY PLAN ${sql}`, ['git:aaaa', '/x/one']) as Array<{ detail: string }>)
      .map((r) => r.detail).join('\n');
    expect(plan).toContain('MULTI-INDEX OR');
    expect(plan).toContain('idx_messages_project_key');

    d.exec('DROP INDEX idx_messages_project_key');
    const scan = (d.all(`EXPLAIN QUERY PLAN ${sql}`, ['git:aaaa', '/x/one']) as Array<{ detail: string }>)
      .map((r) => r.detail).join('\n');
    expect(scan).toContain('SCAN');
    expect(scan).not.toContain('idx_messages_project_key');
  });
});
