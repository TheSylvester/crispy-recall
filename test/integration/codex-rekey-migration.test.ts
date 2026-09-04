/**
 * Codex message-id re-key migration (spec §5).
 *
 * Fixture: a 0.3.1-generation DB (current DDL, retrieval marker complete, NO
 * `codex_message_id_v2` marker) holding four legacy-id Codex sessions that
 * exercise every file-resolution branch — provenance (A), the local Codex tree
 * with no provenance row (B), the hub mirror (C), and nothing at all (D).
 *
 * Proves: the gate fails closed for every normal opener; the migration re-keys
 * A/B/C, keeps D, reports the drain gap it opens, is idempotent; a session
 * whose newly readable >8 KB `session_meta` reclassifies it is NOT counted as
 * re-ingested; and `recall install` clears the marker by itself while quiescing
 * and restoring the Stop hook.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit `env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }`; a child that inherits the parent env resolves
 * `recallRoot()` to the live `~/.recall` (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb, MigrationPendingError, RETRIEVAL_SCHEMA_DDL } from '../../src/db.js';
import {
  runCodexRekeyMigration, LEGACY_CODEX_ID_SQL, CODEX_REKEY_KEY,
} from '../../src/installer/codex-rekey-migration.js';
import { repairRekeyCodex } from '../../src/installer/repair.js';
import { getEmbeddingGapStats, getEmbedVersionStats } from '../../src/recall/message-store.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');
const HOOK_BUNDLE = join(ROOT, 'dist', 'stop-hook.js');

const A = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63'; // provenance row
const B = '11111111-2222-3333-4444-555555555555'; // local codex tree only
const C = '22222222-3333-4444-5555-666666666666'; // hub mirror only
const D = '33333333-4444-5555-6666-777777777777'; // transcript gone
const E_FILE = '44444444-5555-6666-7777-888888888888'; // filename uuid
const E_META = '55555555-6666-7777-8888-999999999999'; // >8 KB session_meta id
const F = '66666666-7777-8888-9999-aaaaaaaaaaaa'; // rollout yields 0 indexable rows
const HOST = 'sylvester-laptop';

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

/** A rollout: session_meta first, then the given text messages. */
function rolloutLines(
  meta: Record<string, unknown>,
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
): string {
  const lines = [JSON.stringify({ timestamp: '2026-09-04T00:00:00.000Z', type: 'session_meta', payload: meta })];
  messages.forEach((m, i) => {
    lines.push(JSON.stringify({
      timestamp: `2026-09-04T00:00:${String(i + 1).padStart(2, '0')}.000Z`,
      type: 'response_item',
      payload: {
        type: 'message', role: m.role,
        content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.text }],
      },
    }));
  });
  return lines.join('\n') + '\n';
}

function codexRollout(sid: string, name: string): string {
  const dir = join(codexHome, 'sessions', '2026', '09', '04');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  return p;
}

function pathA(): string { return codexRollout(A, `rollout-2026-09-04T00-00-00-${A}.jsonl`); }
function pathB(): string { return codexRollout(B, `rollout-2026-09-04T00-01-00-${B}.jsonl`); }
function pathC(): string {
  const dir = join(remoteRoot, HOST, 'codex', 'sessions', '2026', '09', '04');
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-09-04T00-02-00-${C}.jsonl`);
}
function pathE(): string { return codexRollout(E_FILE, `rollout-2026-09-04T00-03-00-${E_FILE}.jsonl`); }
function pathF(): string { return codexRollout(F, `rollout-2026-09-04T00-05-00-${F}.jsonl`); }

/** Session F: legacy rows whose rollout holds ONLY a session_meta line, so a
 *  force re-ingest would insert nothing and DELETE the existing rows. */
function addSessionF(): void {
  writeFileSync(pathF(), JSON.stringify({
    timestamp: '2026-09-04T00:05:00.000Z', type: 'session_meta', payload: { id: F, cwd: '/proj' },
  }) + '\n');
  const raw = new Database(dbPath());
  try {
    raw.prepare(
      `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
       VALUES (?, ?, 0, ?, '/proj', 1006, 'assistant', 'hot')`,
    ).run(legacyId(F, 0), F, `foxtrot merlin answer${PAD}`);
  } finally {
    raw.close();
  }
}

/** A 0.3.1-generation DB: current DDL + retrieval marker, NO codex marker. */
function buildFixture(): void {
  writeFileSync(pathA(), rolloutLines({ id: A, cwd: '/proj' }, [
    { role: 'user', text: `alpha heron prompt${PAD}` },
    { role: 'assistant', text: `alpha heron answer${PAD}` },
  ]));
  writeFileSync(pathB(), rolloutLines({ id: B, cwd: '/proj' }, [
    { role: 'assistant', text: `bravo pelican answer${PAD}` },
  ]));
  writeFileSync(pathC(), rolloutLines({ id: C, cwd: '/proj' }, [
    { role: 'assistant', text: `charlie gannet answer${PAD}` },
  ]));

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
    CREATE INDEX IF NOT EXISTS idx_watermark_vendor ON ingest_watermark(vendor);
  `);
  const ins = raw.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
     VALUES (?, ?, ?, ?, '/proj', ?, ?, 'hot')`,
  );
  const vec = raw.prepare(
    `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
  );
  const blob = Buffer.alloc(768, 1);
  raw.exec('BEGIN IMMEDIATE');
  // A: two rows, both vectored (the vectors the migration must drop).
  ins.run(legacyId(A, 0), A, 0, `alpha heron prompt${PAD}`, 1000, 'user');
  ins.run(legacyId(A, 1), A, 1, `alpha heron answer${PAD}`, 1001, 'assistant');
  vec.run(legacyId(A, 0), blob, EMBED_VERSION);
  vec.run(legacyId(A, 1), blob, EMBED_VERSION);
  // B and C: one row each, no provenance, no watermark, no vectors.
  ins.run(legacyId(B, 0), B, 0, `bravo pelican answer${PAD}`, 1002, 'assistant');
  ins.run(legacyId(C, 0), C, 0, `charlie gannet answer${PAD}`, 1003, 'assistant');
  // D: transcript gone.
  ins.run(legacyId(D, 0), D, 0, `delta osprey answer${PAD}`, 1004, 'assistant');
  // Provenance for A only (1,102 live sessions have no row at all).
  raw.prepare(
    `INSERT INTO session_provenance (session_id, vendor, kind, transcript_path, updated_at) VALUES (?, 'codex', 'root', ?, 1)`,
  ).run(A, pathA().replace(/\\/g, '/'));
  // 0.3.1 generation: retrieval marker complete, codex marker ABSENT.
  raw.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('retrieval_class_migration', 'complete')`).run();
  raw.exec('COMMIT');
  raw.close();
}

/** Session E: a child rollout whose >8 KB session_meta carries a DIFFERENT id. */
function addSessionE(): void {
  const payload: Record<string, unknown> = {
    id: E_META,
    cwd: '/proj',
    git: { commit_hash: 'abc123', branch: 'main' },
    source: { subagent: { thread_spawn: { parent_thread_id: A, depth: 1, agent_type: 'worker' } } },
  };
  let pad = 0;
  const line = () => JSON.stringify({ timestamp: '2026-09-04T00:03:00.000Z', type: 'session_meta', payload });
  while (Buffer.byteLength(line()) < 20 * 1024) {
    pad += 1;
    (payload['git'] as Record<string, unknown>)['branch'] = 'b'.repeat(pad * 512);
  }
  writeFileSync(pathE(), [
    line(),
    JSON.stringify({
      timestamp: '2026-09-04T00:03:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `echo kestrel answer${PAD}` }] },
    }),
  ].join('\n') + '\n');

  const raw = new Database(dbPath());
  raw.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
     VALUES (?, ?, 0, ?, '/proj', 1005, 'assistant', 'hot')`,
  ).run(legacyId(E_FILE, 0), E_FILE, `echo kestrel answer${PAD}`);
  // No provenance row: a stored path→id mapping would pin the canonical id to
  // E_FILE and hide the reclassification this case is about. The rollout is
  // found by the local-tree scan instead.
  raw.close();
}

function ids(sessionId: string): string[] {
  const raw = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(`SELECT message_id FROM messages WHERE session_id = ? ORDER BY message_id`)
      .all(sessionId) as Array<{ message_id: string }>).map((r) => r.message_id);
  } finally {
    raw.close();
  }
}

function legacySessions(): string[] {
  const raw = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(
      `SELECT DISTINCT session_id AS s FROM messages WHERE ${LEGACY_CODEX_ID_SQL} ORDER BY s`,
    ).all() as Array<{ s: string }>).map((r) => r.s);
  } finally {
    raw.close();
  }
}

function markerValue(): string | undefined {
  const raw = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(CODEX_REKEY_KEY) as { value?: string } | undefined)?.value;
  } finally {
    raw.close();
  }
}

/** Simulate ONE drain of exactly what the re-key de-vectorized: session A's
 *  re-keyed hot rows. B/C/D never had vectors, so they stay in the gap. */
function simulateDrain(): void {
  const raw = new Database(dbPath());
  try {
    const rows = raw.prepare(
      `SELECT message_id FROM messages m WHERE m.retrieval_class = 'hot'
         AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id = m.message_id)
         AND m.session_id = ?`,
    ).all(A) as Array<{ message_id: string }>;
    const ins = raw.prepare(
      `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
    );
    for (const r of rows) ins.run(r.message_id, Buffer.alloc(768, 1), EMBED_VERSION);
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-codex-rekey-${randomUUID()}`);
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

describe.skipIf(platform() === 'win32')('codex re-key migration (§5)', () => {
  it('is isolated: dbPath() points inside the temp root, never the live ~/.recall', () => {
    expect(resolve(dbPath()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(dbPath()).startsWith(resolve(recallHome))).toBe(true);
  });

  it('fails closed: getDb throws, the CLI exits 1, the Stop hook exits 0 and inserts nothing', () => {
    if (!existsSync(CLI_BUNDLE) || !existsSync(HOOK_BUNDLE)) {
      throw new Error('dist bundles missing — run `npm run build` first');
    }
    try {
      getDb(dbPath());
      throw new Error('expected the codex-rekey gate to fail closed');
    } catch (e) {
      expect(e).toBeInstanceOf(MigrationPendingError);
      expect((e as MigrationPendingError).kind).toBe('codex-rekey');
      expect((e as Error).message).toMatch(/one-time Codex message-id migration/);
    }
    _resetDb();

    const cli = spawnSync(process.execPath, [CLI_BUNDLE, 'alpha heron', '--no-catchup'], {
      env: childEnv(), encoding: 'utf-8', timeout: 30_000,
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/one-time Codex message-id migration/);
    expect(cli.stderr).toMatch(/recall repair --rekey-codex/);

    // A GROWN copy of A's rollout: a force-LESS re-ingest under the new binary
    // would insert full-uuid rows BESIDE the 8-hex rows. The gate refuses it.
    appendFileSync(pathA(), JSON.stringify({
      timestamp: '2026-09-04T00:00:09.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `alpha heron follow-up${PAD}` }] },
    }) + '\n');
    const before = ids(A);
    const hook = spawnSync(process.execPath, [HOOK_BUNDLE], {
      input: JSON.stringify({ session_id: A, transcript_path: pathA(), cwd: '/proj', hook_event_name: 'Stop' }),
      env: childEnv(), encoding: 'utf-8', timeout: 30_000,
    });
    expect(hook.status).toBe(0);
    expect(ids(A)).toEqual(before); // nothing inserted
    const logText = readFileSync(join(recallHome, 'logs', 'stop-hook.log'), 'utf-8');
    expect(logText).toMatch(/ingest-failed/);
    expect(logText).toMatch(/Codex message-id migration/);

    const pending = spawnSync(process.execPath, [join(ROOT, 'dist', 'embed-pending.js'), A], {
      env: childEnv(), encoding: 'utf-8', timeout: 30_000,
    });
    expect(pending.status).toBe(0);
  }, 60_000);

  it('re-keys every resolvable session, keeps the rest, and opens the drain gap it reports', async () => {
    // Prime the cached connection through the attended door: a normal open
    // would fail closed and getEmbeddingGapStats would report a fallback 0.
    getDb(dbPath(), { allowPendingMigration: true });
    const gapBefore = getEmbeddingGapStats().gapCount;
    _resetDb();

    const lines: string[] = [];
    const res = await runCodexRekeyMigration({ log: (l) => lines.push(l) });
    expect(res.performed).toBe(true);
    expect(res.sessions).toBe(4);
    expect(res.reingested).toBe(3); // A (provenance), B (codex tree), C (mirror)
    expect(res.fileGone).toBe(1);   // D
    expect(res.emptied).toBe(0);
    expect(res.legacyRemaining).toBe(1);
    expect(res.fileGone).toBe(res.legacyRemaining);
    expect(res.vectorsDropped).toBe(2); // A's two vectors
    expect(lines.join('\n')).toMatch(/vectors dropped: 2/);
    expect(lines.join('\n')).toMatch(
      /codex re-key: 4 sessions, 3 re-ingested, 1 transcripts gone, 0 empty transcripts skipped, 2 vectors dropped/,
    );

    // Rollback insurance: a WAL-safe snapshot taken BEFORE the first rewrite.
    expect(res.snapshotPath).toBeTruthy();
    expect(existsSync(res.snapshotPath!)).toBe(true);
    const snap = new Database(res.snapshotPath!, { readonly: true, fileMustExist: true });
    try {
      const legacyInSnapshot = (snap.prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`,
      ).get() as { c: number }).c;
      expect(legacyInSnapshot).toBe(5); // every pre-migration legacy row
    } finally {
      snap.close();
    }
    expect(markerValue()).toBe('complete');

    // A/B/C carry full-uuid ids only; D is untouched.
    for (const sid of [A, B, C]) {
      const rowIds = ids(sid);
      expect(rowIds.length, sid).toBeGreaterThan(0);
      for (const id of rowIds) expect(id.startsWith(`codex-jsonl-${sid}-`), id).toBe(true);
    }
    expect(ids(D)).toEqual([legacyId(D, 0)]);
    expect(legacySessions()).toEqual([D]);

    // The drain gap grew by exactly A's hot-row count (its vectors were dropped).
    _resetDb();
    const gapAfter = getEmbeddingGapStats().gapCount;
    expect(gapAfter - gapBefore).toBe(ids(A).length);
    expect(getEmbedVersionStats().coverage).toBe(1); // coverage cannot see the gap

    // One drain closes it again.
    _resetDb();
    simulateDrain();
    _resetDb();
    expect(getEmbeddingGapStats().gapCount).toBe(gapBefore);
  }, 60_000);

  it('a session reclassified by its newly readable session_meta is NOT counted as re-ingested', async () => {
    addSessionE();
    _resetDb();

    const lines: string[] = [];
    const res = await runCodexRekeyMigration({ log: (l) => lines.push(l) });
    expect(res.sessions).toBe(5);
    expect(res.reingested).toBe(3); // E excluded
    expect(res.fileGone).toBe(1);
    // D (gone) + E (reclassified) still carry legacy ids → the warn fires.
    expect(res.legacyRemaining).toBe(2);
    expect(lines.join('\n')).toMatch(
      new RegExp(`codex-rekey: ${E_FILE} reclassified to ${E_META}; legacy rows under ${E_FILE} kept`),
    );
    expect(lines.join('\n')).toMatch(/warn: codex-rekey: 2 sessions still carry legacy ids/);
    expect(ids(E_FILE)).toEqual([legacyId(E_FILE, 0)]);
    expect(markerValue()).toBe('complete');
  }, 60_000);

  it('never purges a session whose transcript yields zero indexable rows', async () => {
    addSessionF();
    _resetDb();

    const lines: string[] = [];
    const res = await runCodexRekeyMigration({ log: (l) => lines.push(l) });
    expect(res.sessions).toBe(5);
    expect(res.reingested).toBe(3); // A, B, C — F skipped, D gone
    expect(res.emptied).toBe(1);
    expect(res.fileGone).toBe(1);
    expect(res.legacyRemaining).toBe(2); // D + F
    expect(lines.join('\n')).toMatch(
      new RegExp(`codex-rekey: ${F} — .*yielded 0 indexable entries; legacy ids KEPT`),
    );
    // F's history survives untouched — the owner declined a meta purge.
    expect(ids(F)).toEqual([legacyId(F, 0)]);
  }, 60_000);

  it('drains even when the dropped vectors sit on a reclassified session', async () => {
    // E is the ONLY session carrying vectors, and E reclassifies: the ingest
    // layer still dropped them, so the drain decision must fire.
    addSessionE();
    const raw = new Database(dbPath());
    try {
      raw.prepare(`DELETE FROM message_vectors`).run();
      raw.prepare(
        `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1.0, 1.0, ?)`,
      ).run(legacyId(E_FILE, 0), Buffer.alloc(768, 1), EMBED_VERSION);
    } finally {
      raw.close();
    }
    _resetDb();

    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); });
    let res: Awaited<ReturnType<typeof repairRekeyCodex>>;
    try {
      res = await repairRekeyCodex({ yes: true });
    } finally {
      spy.mockRestore();
    }
    expect(res).not.toBeNull();
    expect(res!.reingested).toBe(3);
    expect(res!.vectorsDropped).toBeGreaterThan(0); // E's vector, on the reclassified branch
    // No embed-pending.js is staged here, so the drain surfaces as the hint.
    expect(printed.join('\n')).toMatch(/run: recall backfill --auto-embed/);
  }, 60_000);

  it('is idempotent: a second run performs nothing', async () => {
    const first = await runCodexRekeyMigration({ log: () => {} });
    expect(first.performed).toBe(true);
    _resetDb();
    const rows = ids(A);

    const second = await runCodexRekeyMigration({ log: () => {} });
    expect(second).toEqual({
      performed: false, sessions: 0, reingested: 0, fileGone: 0, emptied: 0,
      vectorsDropped: 0, legacyRemaining: 0, snapshotPath: null,
    });
    _resetDb();
    expect(ids(A)).toEqual(rows);
  }, 60_000);

  it('after the migration, spawned children work normally again', async () => {
    if (!existsSync(CLI_BUNDLE) || !existsSync(HOOK_BUNDLE)) {
      throw new Error('dist bundles missing — run `npm run build` first');
    }
    await runCodexRekeyMigration({ log: () => {} });
    _resetDb();

    const cli = spawnSync(process.execPath, [CLI_BUNDLE, '--list', '--no-catchup', '--all'], {
      env: childEnv(), encoding: 'utf-8', timeout: 30_000,
    });
    expect(cli.stderr).not.toMatch(/Codex message-id migration/);
    expect(cli.status).toBe(0);

    // The Stop hook ingests a grown rollout normally now.
    appendFileSync(pathA(), JSON.stringify({
      timestamp: '2026-09-04T00:00:09.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `alpha heron follow-up${PAD}` }] },
    }) + '\n');
    const before = ids(A).length;
    const hook = spawnSync(process.execPath, [HOOK_BUNDLE], {
      input: JSON.stringify({ session_id: A, transcript_path: pathA(), cwd: '/proj', hook_event_name: 'Stop' }),
      env: childEnv(), encoding: 'utf-8', timeout: 30_000,
    });
    expect(hook.status).toBe(0);
    expect(ids(A).length).toBe(before + 1);
  }, 60_000);

  it('`recall install` clears the marker itself and restores the quiesced Stop hook (rule 9a)', async () => {
    const { runInstall } = await import('../../src/installer/install.js');
    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'node /pre/existing.js' }] },
          { matcher: '', hooks: [{ type: 'command', command: `"node" "${join(recallHome, 'bin', 'stop-hook.js')}"` }] },
        ],
      },
    }, null, 2));

    // Stub bundles + offline runtime so the install reaches phase 6.8 without
    // downloading a runtime, a model, or running real GPU detection.
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

    const res = await runInstall({
      yes: true, offline: true, gpuDetect: async () => false,
      noBackfill: true, noClaudemd: true, distDir,
    });
    expect(res.aborted).toBeFalsy();
    expect(res.migration?.codexRekey?.performed).toBe(true);
    expect(res.migration!.codexRekey!.vectorsDropped).toBeGreaterThan(0);
    expect(markerValue()).toBe('complete');
    expect(legacySessions()).toEqual([D]);

    // The drain the migration owes is genuinely pending: the phase-8 skip
    // predicate is false against this post-install DB.
    _resetDb();
    expect(getEmbeddingGapStats().gapCount).toBeGreaterThan(0);
    const skipDrain = res.migration!.state === 'already-migrated'
      && getEmbedVersionStats().coverage >= 1
      && getEmbeddingGapStats().gapCount === 0;
    expect(skipDrain).toBe(false);

    // Quiesced then restored: the recall Stop hook is wired at the staged path.
    const settings = readFileSync(settingsPath, 'utf-8');
    expect(settings).toMatch(/stop-hook\.js/);
    expect(settings).toMatch(/pre\/existing\.js/);
  }, 120_000);
});
