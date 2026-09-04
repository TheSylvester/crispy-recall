/**
 * Codex message-id re-key — the id shape itself (spec §5).
 *
 * The adapter must synthesize `codex-jsonl-<FULL uuid>-<counter>`: an 8-hex
 * UUIDv7 prefix is a ~65 s bucket, so sibling sessions collided and
 * `INSERT OR IGNORE` silently dropped their turns. `LEGACY_CODEX_ID_SQL` is
 * exercised THROUGH SQLite, never through a JS regex — the migration's
 * enumeration depends on SQLite's own LIKE semantics.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit `env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }`; a child that inherits the parent env resolves
 * `recallRoot()` to the live `~/.recall` (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb } from '../../src/db.js';
import { adaptCodexJsonlRecords } from '../../src/adapters/codex/codex-jsonl-adapter.js';
import { LEGACY_CODEX_ID_SQL } from '../../src/installer/codex-rekey-migration.js';

const SID = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';

// This suite touches no recall database (a pure adapter call and an in-memory
// SQLite handle), but it carries the isolation block anyway so a future edit
// cannot silently reach the owner's live ~/.recall.
let recallHome: string;
let restoreRoot: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-rekey-id-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['RECALL_HOME', 'RECALL_REMOTE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) prevEnv[k] = process.env[k];
  process.env['RECALL_HOME'] = recallHome;
  process.env['RECALL_REMOTE_ROOT'] = join(recallHome, 'remote');
  process.env['CLAUDE_CONFIG_DIR'] = join(recallHome, 'claude');
  process.env['CODEX_HOME'] = join(recallHome, 'codex');
  _resetDb();
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

function rollout(): Array<Record<string, unknown>> {
  return [
    { timestamp: '2026-02-07T20:34:15.000Z', type: 'session_meta', payload: { id: SID, cwd: '/home/u/proj' } },
    { timestamp: '2026-02-07T20:34:17.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing test' }] } },
    { timestamp: '2026-02-07T20:34:18.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'off-by-one' }] } },
    { timestamp: '2026-02-07T20:34:21.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ];
}

describe('codex re-key: synthesized message ids', () => {
  it('is isolated: dbPath() points inside the temp root, never the live ~/.recall', () => {
    expect(resolve(dbPath()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(dbPath()).startsWith(resolve(recallHome))).toBe(true);
  });

  it('every synthesized id carries the FULL session uuid', () => {
    const entries = adaptCodexJsonlRecords(rollout() as never, SID) as Array<{ uuid?: string }>;
    const synthesized = entries
      .map((e) => e.uuid ?? '')
      .filter((u) => u.startsWith('codex-jsonl-'));

    expect(synthesized.length).toBeGreaterThan(0);
    for (const id of synthesized) {
      expect(id.startsWith(`codex-jsonl-${SID}-`)).toBe(true);
      expect(id).toMatch(/^codex-jsonl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/);
    }
    // No id may keep the 8-hex prefix shape.
    expect(synthesized.some((id) => id === `codex-jsonl-${SID.slice(0, 8)}-0`)).toBe(false);
  });

  it('doctor reads the id constants from the db leaf, never from the migration module', () => {
    const doctorSrc = readFileSync(join(__dirname, '..', '..', 'src', 'installer', 'doctor.ts'), 'utf-8');
    // doctor must not pull in the migration's ingest/glob module graph.
    expect(doctorSrc).not.toMatch(/from '\.\/codex-rekey-migration\.js'/);
    expect(doctorSrc).toMatch(/LEGACY_CODEX_ID_SQL.*from '\.\.\/db\.js'/);
  });

  it('LEGACY_CODEX_ID_SQL selects legacy ids only — proven through SQLite', () => {
    const raw = new Database(':memory:');
    try {
      raw.exec('CREATE TABLE messages (message_id TEXT PRIMARY KEY, session_id TEXT)');
      const ins = raw.prepare('INSERT INTO messages (message_id, session_id) VALUES (?, ?)');
      const legacy = [
        `codex-jsonl-${SID.slice(0, 8)}-0`,
        `codex-jsonl-${SID.slice(0, 8)}-137`,
        'codex-jsonl-deadbeef-2',
      ];
      const modern = [
        `codex-jsonl-${SID}-0`,
        `codex-jsonl-${SID}-137`,
        '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63-m0', // a Claude uuid — never matched
        'call_1',
      ];
      for (const id of legacy) ins.run(id, SID);
      for (const id of modern) ins.run(id, SID);

      const hits = (raw
        .prepare(`SELECT message_id FROM messages WHERE ${LEGACY_CODEX_ID_SQL} ORDER BY message_id`)
        .all() as Array<{ message_id: string }>).map((r) => r.message_id);
      expect(hits.sort()).toEqual([...legacy].sort());
    } finally {
      raw.close();
    }
  });
});
