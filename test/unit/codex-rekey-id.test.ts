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
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { adaptCodexJsonlRecords } from '../../src/adapters/codex/codex-jsonl-adapter.js';
import { LEGACY_CODEX_ID_SQL } from '../../src/installer/codex-rekey-migration.js';

const SID = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';

function rollout(): Array<Record<string, unknown>> {
  return [
    { timestamp: '2026-02-07T20:34:15.000Z', type: 'session_meta', payload: { id: SID, cwd: '/home/u/proj' } },
    { timestamp: '2026-02-07T20:34:17.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing test' }] } },
    { timestamp: '2026-02-07T20:34:18.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'off-by-one' }] } },
    { timestamp: '2026-02-07T20:34:21.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ];
}

describe('codex re-key: synthesized message ids', () => {
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
