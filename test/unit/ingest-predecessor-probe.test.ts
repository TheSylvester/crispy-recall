/**
 * The per-row predecessor probe is gone (M4).
 *
 * `insertMessages` used to run
 *   SELECT 1 FROM messages WHERE session_id = ? AND message_seq >= ? LIMIT 1
 * for every NEW row, and `messages` carries no (session_id, message_seq) index
 * (db.ts RETRIEVAL_SCHEMA_DDL), so a first-time or forced ingest of an N-row
 * session walked O(N^2). The session's stored rows are already read once per
 * session a few lines above; the max sequence from that read answers the same
 * question. These tests pin BOTH halves: the probe is never issued, and a real
 * predecessor insert still invalidates the session's vectors.
 *
 * Isolated via `_setTestRoot`; the live ~/.recall is never opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { insertMessages } from '../../src/recall/message-store.js';

const embedBatch = vi.hoisted(() => vi.fn());
vi.mock('../../src/recall/embedder.js', () => ({ embedBatch }));

const PAD = ' padded well beyond the fifty character minimum embedding floor.';
const PROBE = /message_seq\s*>=/;

let dir: string;
let restore: () => void;

/** Wrap the singleton's `get` and return every SQL string it is handed. */
function recordGets(): string[] {
  const seen: string[] = [];
  const d = getDb(dbPath()) as unknown as { get: (sql: string, params?: unknown[]) => unknown };
  const original = d.get.bind(d);
  d.get = (sql: string, params?: unknown[]) => { seen.push(sql); return original(sql, params); };
  return seen;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recall-predecessor-probe-'));
  restore = _setTestRoot(dir);
  _resetDb();
  embedBatch.mockReset();
});
afterEach(() => { _resetDb(); restore(); rmSync(dir, { recursive: true, force: true }); });

describe('insertMessages predecessor detection', () => {
  it('never issues the message_seq >= probe for a brand-new session', async () => {
    const N = 3000;
    const entries = Array.from({ length: N }, (_, i) => JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: `probe-${i}`,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}${PAD}` },
    }));
    const path = join(dir, 'big.jsonl');
    writeFileSync(path, entries.join('\n') + '\n');

    const seen = recordGets();
    const result = await ingestSessionMessages('big', path, 'claude');
    expect(result.error).toBeUndefined();
    expect(result.chunksCreated).toBe(N);

    expect(seen.filter(sql => PROBE.test(sql))).toEqual([]);
    // Per-row work stays a small constant number of PRIMARY-KEY lookups.
    expect(seen.length).toBeLessThan(N * 4);
  }, 120_000);

  it('does not issue the probe on a forced re-ingest either', async () => {
    const path = join(dir, 'forced.jsonl');
    writeFileSync(path, Array.from({ length: 50 }, (_, i) => JSON.stringify({
      type: 'user', uuid: `forced-${i}`, timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: `forced turn ${i}${PAD}` },
    })).join('\n') + '\n');
    await ingestSessionMessages('forced', path, 'claude');

    const seen = recordGets();
    await ingestSessionMessages('forced', path, 'claude', { force: true });
    expect(seen.filter(sql => PROBE.test(sql))).toEqual([]);
  }, 60_000);

  it('still invalidates the session vectors when a predecessor is inserted', () => {
    const base = {
      session_id: 'pred', project_id: '/proj', message_role: 'assistant' as const,
    };
    insertMessages([
      { ...base, message_id: 'later', message_seq: 5, message_text: `later turn${PAD}`, created_at: 1005 },
    ]);
    const d = getDb(dbPath());
    d.run(
      `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version)
       VALUES ('later', ?, 1.0, 1.0, 3)`,
      [Buffer.alloc(768, 1)],
    );
    expect((d.get('SELECT COUNT(*) AS c FROM message_vectors') as { c: number }).c).toBe(1);

    // Both ids present, so the session is NOT treated as truncated: 'earlier'
    // lands before the stored max and must drop the session's vectors.
    insertMessages([
      { ...base, message_id: 'later', message_seq: 5, message_text: `later turn${PAD}`, created_at: 1005 },
      { ...base, message_id: 'earlier', message_seq: 2, message_text: `earlier turn${PAD}`, created_at: 1002 },
    ]);

    expect((d.get('SELECT COUNT(*) AS c FROM message_vectors') as { c: number }).c).toBe(0);
    expect((d.get('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?', ['pred']) as { c: number }).c).toBe(2);
  });

  it('leaves the vectors alone when every new row appends after the stored max', () => {
    const base = {
      session_id: 'append', project_id: '/proj', message_role: 'assistant' as const,
    };
    insertMessages([
      { ...base, message_id: 'a0', message_seq: 0, message_text: `first turn${PAD}`, created_at: 1000 },
    ]);
    const d = getDb(dbPath());
    d.run(
      `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version)
       VALUES ('a0', ?, 1.0, 1.0, 3)`,
      [Buffer.alloc(768, 1)],
    );

    insertMessages([
      { ...base, message_id: 'a0', message_seq: 0, message_text: `first turn${PAD}`, created_at: 1000 },
      { ...base, message_id: 'a1', message_seq: 1, message_text: `second turn${PAD}`, created_at: 1001 },
      { ...base, message_id: 'a2', message_seq: 2, message_text: `third turn${PAD}`, created_at: 1002 },
    ]);

    expect((d.get('SELECT COUNT(*) AS c FROM message_vectors') as { c: number }).c).toBe(1);
  });
});
