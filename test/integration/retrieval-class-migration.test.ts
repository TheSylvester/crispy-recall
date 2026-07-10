/**
 * §8.3 Migration/repair — retrieval-class migration of an existing database.
 *
 * Builds a PRE-change (0.2.2-generation) DB fixture — hot root rows, Claude
 * agent-* leaf rows, a confidently classifiable Codex child (extant rollout
 * with subagent thread_spawn), an unresolved codex-shaped ghost session,
 * unfiltered external-content FTS, current + stale vectors, watermarks — and
 * proves the §4.5 contract: history-preserving, WAL-safe-snapshot-backed
 * (failure aborts), idempotent, crash-safe, fail-closed for normal commands,
 * exit-0-silent for the Stop hook, and repair-proof afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, statSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb, MigrationPendingError } from '../../src/db.js';
import {
  runRetrievalClassMigration, snapshotDbWalSafe, retrievalMigrationPending,
} from '../../src/installer/retrieval-class-migration.js';
import { searchMessagesFts, readSessionMessages, getUnembeddedMessages, getEmbeddingGapStats } from '../../src/recall/message-store.js';
import { listSessions } from '../../src/recall/memory-queries.js';
import { repairFts, repairVectors, integrityCheck } from '../../src/installer/repair.js';
import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');
const HOOK_BUNDLE = join(ROOT, 'dist', 'stop-hook.js');

const ROOT_SESSION = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const CLAUDE_LEAF = 'agent-abc12345';
const CODEX_CHILD = '11111111-2222-3333-4444-555555555555';
const CODEX_ROOT = '22222222-3333-4444-5555-666666666666';
const GHOST_CODEX = '99999999-8888-7777-6666-555555555555';

const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

/** The EXACT pre-change (0.2.2) schema, verbatim from the old db.ts. */
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

let recallHome: string;
let codexHome: string;
let claudeRoot: string;
let restoreRoot: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

function codexChildTranscriptPath(): string {
  return join(codexHome, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${CODEX_CHILD}.jsonl`);
}

function codexRootTranscriptPath(): string {
  return join(codexHome, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-01-00-${CODEX_ROOT}.jsonl`);
}

function claudeLeafTranscriptPath(): string {
  return join(claudeRoot, 'projects', 'proj', ROOT_SESSION, 'subagents', `${CLAUDE_LEAF}.jsonl`);
}

/** Build the pre-change fixture DB (WAL) + on-disk transcripts + watermarks. */
function buildFixture(): void {
  // Transcripts on disk.
  mkdirSync(join(codexHome, 'sessions', '2026', '01', '01'), { recursive: true });
  writeFileSync(codexChildTranscriptPath(), [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta',
      payload: {
        id: CODEX_CHILD, cwd: '/proj',
        source: { subagent: { thread_spawn: { parent_thread_id: CODEX_ROOT, depth: 1, agent_type: 'worker' } } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `codex child albatross narration${PAD}` }] },
    }),
  ].join('\n') + '\n');
  writeFileSync(codexRootTranscriptPath(), [
    JSON.stringify({
      timestamp: '2026-01-01T00:01:00.000Z', type: 'session_meta',
      payload: { id: CODEX_ROOT, cwd: '/proj' },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:01:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `codex parent pelican narration${PAD}` }] },
    }),
  ].join('\n') + '\n');
  mkdirSync(join(claudeRoot, 'projects', 'proj', ROOT_SESSION, 'subagents'), { recursive: true });
  writeFileSync(claudeLeafTranscriptPath(), JSON.stringify({
    type: 'assistant', uuid: `${CLAUDE_LEAF}-msg-0`, parentUuid: null, sessionId: CLAUDE_LEAF,
    timestamp: '2026-01-01T00:00:00.000Z', cwd: '/proj',
    message: { role: 'assistant', content: `claude leaf gannet narration${PAD}` },
  }) + '\n');

  // Old-generation DB in WAL mode.
  const raw = new Database(dbPath());
  raw.pragma('journal_mode = WAL');
  raw.exec(OLD_SCHEMA);
  const ins = raw.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  );
  const vec = raw.prepare(
    `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
  );
  const blob = Buffer.alloc(768, 1);
  raw.exec('BEGIN IMMEDIATE');
  // Hot root (Claude): one current + one stale vector.
  ins.run(`${ROOT_SESSION}-m0`, ROOT_SESSION, 0, `root heron user prompt${PAD}`, 1000, 'user');
  ins.run(`${ROOT_SESSION}-m1`, ROOT_SESSION, 1, `root heron assistant narration${PAD}`, 1001, 'assistant');
  vec.run(`${ROOT_SESSION}-m0`, blob, 1);              // stale
  vec.run(`${ROOT_SESSION}-m1`, blob, EMBED_VERSION);  // current
  // Claude agent-* leaf rows with a (wrongly hot) vector.
  ins.run(`${CLAUDE_LEAF}-msg-0`, CLAUDE_LEAF, 0, `claude leaf gannet narration${PAD}`, 1002, 'assistant');
  vec.run(`${CLAUDE_LEAF}-msg-0`, blob, EMBED_VERSION);
  // Codex child rows (classifiable from the extant rollout) with a vector.
  ins.run(`codex-jsonl-${CODEX_CHILD.slice(0, 8)}-0`, CODEX_CHILD, 0, `codex child albatross narration${PAD}`, 1003, 'assistant');
  vec.run(`codex-jsonl-${CODEX_CHILD.slice(0, 8)}-0`, blob, EMBED_VERSION);
  // Codex root rows.
  ins.run(`codex-jsonl-${CODEX_ROOT.slice(0, 8)}-0`, CODEX_ROOT, 0, `codex parent pelican narration${PAD}`, 1004, 'assistant');
  // Ghost codex session — transcript long gone. Must stay hot + be reported.
  ins.run(`codex-jsonl-${GHOST_CODEX.slice(0, 8)}-0`, GHOST_CODEX, 0, `ghost osprey narration${PAD}`, 1005, 'assistant');
  // Watermarks.
  const wm = raw.prepare(`INSERT INTO ingest_watermark (transcript_path, last_mtime, last_size, vendor) VALUES (?, 1, 1, ?)`);
  wm.run(codexChildTranscriptPath().replace(/\\/g, '/'), 'codex');
  wm.run(codexRootTranscriptPath().replace(/\\/g, '/'), 'codex');
  wm.run(claudeLeafTranscriptPath().replace(/\\/g, '/'), 'claude');
  raw.exec('COMMIT');
  raw.close();
}

function allMessagesSorted(dbFile: string): Array<{ message_id: string; session_id: string; message_text: string }> {
  const raw = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return raw.prepare(
      `SELECT message_id, session_id, message_text FROM messages ORDER BY message_id`,
    ).all() as Array<{ message_id: string; session_id: string; message_text: string }>;
  } finally {
    raw.close();
  }
}

function schemaObjects(dbFile: string): unknown[] {
  const raw = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return raw.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-migrate-${randomUUID()}`);
  codexHome = join(recallHome, 'codex-fake');
  claudeRoot = join(recallHome, 'claude-fake');
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_HOME']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = claudeRoot;
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
  try { chmodSync(recallHome, 0o755); } catch { /* may already be writable */ }
  rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('retrieval-class migration (§8.3)', () => {
  it('migrates in place: classify, purge, filter — history byte-for-byte preserved', async () => {
    const before = allMessagesSorted(dbPath());
    expect(retrievalMigrationPending()).toBe(true);

    const res = await runRetrievalClassMigration();
    expect(res.performed).toBe(true);
    expect(res.snapshotPath && existsSync(res.snapshotPath)).toBe(true);
    expect(res.agentSessions).toBe(2); // claude leaf + codex child
    expect(res.unresolvedCodexSessions).toBe(1); // the ghost — left hot, reported

    // Byte-for-byte: every message id/session/text survives exactly.
    _resetDb();
    expect(allMessagesSorted(dbPath())).toEqual(before);

    const d = getDb(dbPath());
    // Leaf rows are cold; roots (including the unresolvable ghost) stay hot.
    const cls = (sid: string) =>
      (d.get(`SELECT DISTINCT retrieval_class AS c FROM messages WHERE session_id = ?`, [sid]) as { c: string }).c;
    expect(cls(CLAUDE_LEAF)).toBe('agent');
    expect(cls(CODEX_CHILD)).toBe('agent');
    expect(cls(ROOT_SESSION)).toBe('hot');
    expect(cls(CODEX_ROOT)).toBe('hot');
    expect(cls(GHOST_CODEX)).toBe('hot');

    // Leaf vectors removed; hot vectors (current + stale) retained.
    const vecIds = (d.all(`SELECT message_id FROM message_vectors ORDER BY message_id`) as Array<{ message_id: string }>)
      .map((r) => r.message_id);
    expect(vecIds).toEqual([`${ROOT_SESSION}-m0`, `${ROOT_SESSION}-m1`]);

    // Default retrieval excludes leaves; explicit reads still work.
    expect(searchMessagesFts('heron').length).toBeGreaterThan(0);
    expect(searchMessagesFts('gannet')).toHaveLength(0);
    expect(searchMessagesFts('albatross')).toHaveLength(0);
    expect(searchMessagesFts('osprey').length).toBeGreaterThan(0); // ghost stays searchable
    expect(readSessionMessages(CLAUDE_LEAF, 0, 10)!.messages[0]!.text).toContain('gannet');
    expect(readSessionMessages(CODEX_CHILD, 0, 10)!.messages[0]!.text).toContain('albatross');
    const listed = listSessions(dbPath(), 100).map((s) => s.session_id);
    expect(listed).not.toContain(CLAUDE_LEAF);
    expect(listed).not.toContain(CODEX_CHILD);
    expect(getUnembeddedMessages(100).every((m) => m.session_id !== CLAUDE_LEAF && m.session_id !== CODEX_CHILD)).toBe(true);

    // Provenance durable: parent ids + kinds recorded.
    const prov = d.get(
      `SELECT kind, parent_session_id FROM session_provenance WHERE session_id = ?`, [CODEX_CHILD],
    ) as { kind: string; parent_session_id: string };
    expect(prov.kind).toBe('agent');
    expect(prov.parent_session_id).toBe(CODEX_ROOT);
    const leafProv = d.get(
      `SELECT kind, parent_session_id FROM session_provenance WHERE session_id = ?`, [CLAUDE_LEAF],
    ) as { kind: string; parent_session_id: string };
    expect(leafProv.kind).toBe('agent');
    expect(leafProv.parent_session_id).toBe(ROOT_SESSION); // enriched from the watermarked subagents path

    // FTS integrity (rank-1) + main integrity green.
    const integ = integrityCheck();
    expect(integ.mainOk).toBe(true);
    expect(integ.ftsOk).toBe(true);
  }, 30_000);

  it('rerun is idempotent: second migration is a no-op', async () => {
    const first = await runRetrievalClassMigration();
    expect(first.performed).toBe(true);
    _resetDb();
    const objects = schemaObjects(dbPath());
    const rows = allMessagesSorted(dbPath());

    const second = await runRetrievalClassMigration();
    expect(second.performed).toBe(false);
    _resetDb();
    expect(schemaObjects(dbPath())).toEqual(objects);
    expect(allMessagesSorted(dbPath())).toEqual(rows);
  }, 30_000);

  it('crash mid-transaction rolls back to the intact OLD schema; re-run succeeds', async () => {
    // Simulate the crash: a connection takes the write lock, performs the
    // destructive drops, then dies without committing.
    const raw = new Database(dbPath());
    raw.pragma('busy_timeout = 5000');
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    raw.exec('DROP TRIGGER IF EXISTS messages_fts_au');
    raw.exec('DROP TABLE IF EXISTS messages_fts_vocab');
    raw.exec('DROP TABLE IF EXISTS messages_fts');
    raw.close(); // crash → implicit rollback

    // Still pending, still old-generation, old FTS intact and functional.
    expect(retrievalMigrationPending()).toBe(true);
    const raw2 = new Database(dbPath(), { readonly: true, fileMustExist: true });
    const hit = raw2.prepare(
      `SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'gannet'`,
    ).get() as { c: number };
    raw2.close();
    expect(hit.c).toBe(1); // unfiltered old index still has the leaf

    // Recovery: the migration completes normally afterwards.
    const res = await runRetrievalClassMigration();
    expect(res.performed).toBe(true);
    _resetDb();
    expect(retrievalMigrationPending()).toBe(false);
  }, 30_000);

  it('a concurrent opener mid-migration-transaction fails closed (never sees a half state)', async () => {
    const raw = new Database(dbPath());
    raw.pragma('busy_timeout = 5000');
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    try {
      // A normal opener reads the pre-transaction snapshot (WAL): messages
      // exists, no marker → MigrationPendingError, not a half-migrated view.
      expect(() => getDb(dbPath())).toThrow(MigrationPendingError);
    } finally {
      raw.exec('ROLLBACK');
      raw.close();
    }
  }, 30_000);

  it('WAL-safe snapshot captures committed-but-uncheckpointed frames and restores correctly', async () => {
    // Write rows that stay in the WAL (autocheckpoint off, connection open).
    const writer = new Database(dbPath());
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare(
      `INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at) VALUES (?, ?, 99, ?, 9999)`,
    ).run('wal-frame-msg', ROOT_SESSION, `uncheckpointed cormorant row${PAD}`);
    const walFile = `${dbPath()}-wal`;
    expect(existsSync(walFile) && statSync(walFile).size > 0, 'fixture must have live WAL frames').toBe(true);

    const snap = await snapshotDbWalSafe();
    writer.close();

    // The snapshot (a single consistent file) contains the WAL-only row.
    const check = new Database(snap, { readonly: true, fileMustExist: true });
    const row = check.prepare(`SELECT message_text FROM messages WHERE message_id = 'wal-frame-msg'`).get() as { message_text: string } | undefined;
    expect(row?.message_text).toContain('cormorant');
    // And restores correctly: FTS over the restored copy works (rowid-exact).
    const fts = check.prepare(`SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'heron'`).get() as { c: number };
    expect(fts.c).toBeGreaterThan(0);
    check.close();

    // Restore drill: copy the snapshot over the DB and open it normally… it
    // is a pre-migration DB, so the gate fails closed exactly as designed.
    _resetDb();
    rmSync(`${dbPath()}-wal`, { force: true });
    rmSync(`${dbPath()}-shm`, { force: true });
    copyFileSync(snap, dbPath());
    expect(retrievalMigrationPending()).toBe(true);
  }, 30_000);

  it('a FAILED snapshot aborts the migration before any mutation', async () => {
    const objects = schemaObjects(dbPath());
    chmodSync(recallHome, 0o555); // snapshot dest dir unwritable
    try {
      await expect(runRetrievalClassMigration()).rejects.toThrow(/snapshot failed|snapshot/i);
    } finally {
      chmodSync(recallHome, 0o755);
    }
    _resetDb();
    expect(retrievalMigrationPending()).toBe(true); // nothing was modified
    expect(schemaObjects(dbPath())).toEqual(objects);
  }, 30_000);

  it('a live background drain (embed.lock) aborts the migration with remediation', async () => {
    mkdirSync(join(recallHome, 'run'), { recursive: true });
    writeFileSync(join(recallHome, 'run', 'embed.lock'), String(process.pid)); // verifiably live
    await expect(runRetrievalClassMigration({ drainWaitMs: 400 })).rejects.toThrow(/embedding drain is running/);
    _resetDb();
    expect(retrievalMigrationPending()).toBe(true);
    rmSync(join(recallHome, 'run', 'embed.lock'), { force: true });
  }, 30_000);

  it('a running detached backfill aborts the migration with remediation', async () => {
    mkdirSync(join(recallHome, 'run'), { recursive: true });
    writeFileSync(join(recallHome, 'run', 'backfill.pid'), String(process.pid));
    await expect(runRetrievalClassMigration()).rejects.toThrow(/backfill is running/);
    _resetDb();
    expect(retrievalMigrationPending()).toBe(true);
    rmSync(join(recallHome, 'run', 'backfill.pid'), { force: true });
  }, 30_000);

  it('the Stop hook against a pending-migration DB exits 0 SILENTLY with zero migrating DDL', () => {
    if (!existsSync(HOOK_BUNDLE)) throw new Error('dist/stop-hook.js missing — run `npm run build` first');
    const objectsBefore = schemaObjects(dbPath());
    const r = spawnSync(process.execPath, [HOOK_BUNDLE], {
      input: JSON.stringify({
        session_id: ROOT_SESSION,
        transcript_path: claudeLeafTranscriptPath(),
        cwd: '/proj',
        hook_event_name: 'Stop',
      }),
      env: { ...process.env, RECALL_HOME: recallHome, CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexHome },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // Zero migrating DDL: the schema is byte-identical.
    expect(schemaObjects(dbPath())).toEqual(objectsBefore);
    expect(retrievalMigrationPending()).toBe(true);
  }, 60_000);

  it('normal CLI commands fail closed with the `recall install` message and zero DDL', () => {
    if (!existsSync(CLI_BUNDLE)) throw new Error('dist/recall.js missing — run `npm run build` first');
    const objectsBefore = schemaObjects(dbPath());
    for (const args of [['--list'], ['heron query terms'], ['read', ROOT_SESSION]]) {
      const r = spawnSync(process.execPath, [CLI_BUNDLE, ...args], {
        env: { ...process.env, RECALL_HOME: recallHome, CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexHome },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/recall install/);
      expect(r.stderr).not.toMatch(/at .*\.js:\d/); // concise message, not a stack trace
    }
    expect(schemaObjects(dbPath())).toEqual(objectsBefore);
  }, 60_000);

  it('an aborted attended migration restores the EXACT prior Stop-hook configuration', async () => {
    // Attended context: settings.json carries the user's recall Stop hook (plus
    // a foreign hook) before the install quiesces it.
    const { runInstall } = await import('../../src/installer/install.js');
    mkdirSync(claudeRoot, { recursive: true });
    const settingsPath = join(claudeRoot, 'settings.json');
    const priorSettings = JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: '/usr/bin/users-own-hook.sh' }] },
          { matcher: '', hooks: [{ type: 'command', command: `"node" "${join(recallHome, 'bin', 'stop-hook.js')}"` }] },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, priorSettings);

    // Stage stub bundles + offline runtime so install reaches phase 6.7.
    const distDir = join(recallHome, 'stub-dist');
    mkdirSync(distDir, { recursive: true });
    for (const f of ['recall.js', 'stop-hook.js', 'embed-pending.js', 'statusline.js']) {
      writeFileSync(join(distDir, f), 'process.exit(0);\n');
    }
    const { getBinaryPath, getModelPath } = await import('../../src/recall/embedder.js');
    mkdirSync(join(recallHome, 'bin'), { recursive: true });
    mkdirSync(join(recallHome, 'models'), { recursive: true });
    writeFileSync(getBinaryPath(), 'stub');
    writeFileSync(getModelPath(), 'stub');

    // A live drain forces the retrieval migration to abort.
    mkdirSync(join(recallHome, 'run'), { recursive: true });
    writeFileSync(join(recallHome, 'run', 'embed.lock'), String(process.pid));

    const res = await runInstall({
      yes: true, offline: true, distDir,
      gpuDetect: async () => false,
    });
    expect(res.aborted).toBe(true);
    expect(res.abortReason).toMatch(/embedding drain is running/);
    // The exact prior hook configuration is back — recall is not silently disabled.
    expect(readFileSync(settingsPath, 'utf-8')).toBe(priorSettings);
    // And the DB is still pending (nothing half-migrated).
    _resetDb();
    expect(retrievalMigrationPending()).toBe(true);
    rmSync(join(recallHome, 'run', 'embed.lock'), { force: true });
  }, 60_000);

  it('repair --fts and --vectors + T1 rescans do not resurrect cold content', async () => {
    await runRetrievalClassMigration();

    // repair --fts rebuilds from the filtered view.
    repairFts();
    expect(searchMessagesFts('gannet')).toHaveLength(0);
    expect(searchMessagesFts('albatross')).toHaveLength(0);
    expect(searchMessagesFts('heron').length).toBeGreaterThan(0);

    // repair --vectors clears everything; the hot-only selectors offer only
    // hot rows for re-embedding.
    repairVectors();
    const gap = getEmbeddingGapStats();
    const d = getDb(dbPath());
    const agentEligible = getUnembeddedMessages(1000).filter(
      (m) => m.session_id === CLAUDE_LEAF || m.session_id === CODEX_CHILD,
    );
    expect(agentEligible).toHaveLength(0);
    expect(gap.totalMessages).toBe(
      (d.get(`SELECT COUNT(*) AS c FROM messages WHERE retrieval_class = 'hot' AND message_text != ''`) as { c: number }).c,
    );

    // T1 mtime-scan re-reads the (touched) child transcript: stored provenance
    // keeps it agent — no resurrection into FTS.
    const { utimesSync } = await import('node:fs');
    utimesSync(codexChildTranscriptPath(), new Date(), new Date());
    const scan = await mtimeScan();
    expect(scan.failed).toBe(0);
    expect(searchMessagesFts('albatross')).toHaveLength(0);
    const cls = (d.get(
      `SELECT DISTINCT retrieval_class AS c FROM messages WHERE session_id = ?`, [CODEX_CHILD],
    ) as { c: string }).c;
    expect(cls).toBe('agent');
  }, 60_000);
});
