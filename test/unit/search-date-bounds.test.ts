import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { searchMessagesFts, searchMessagesSemantic } from '../../src/recall/message-store.js';
import { parseDateBounds } from '../../src/recall/date-bounds.js';
import { listSessions } from '../../src/recall/memory-queries.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

let root: string;
let restore: () => void;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recall-search-dates-'));
  restore = _setTestRoot(root);
  _resetDb();
  const db = getDb(dbPath());
  for (let i = 0; i < 606; i++) {
    // 605 stronger, out-of-window matches hide the final old row without pushdown.
    db.run(`INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, project_key, created_at, message_role)
      VALUES (?, 'session', ?, ?, '/repo', 'repo-key', ?, 'user')`,
    [`m${i}`, i, i === 605 ? 'zebrafoo ' + 'filler '.repeat(100) : 'zebrafoo', i === 605 ? 1000 : 2000]);
    db.run(`INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version) VALUES (?, ?, 1, 1, ?)`,
      [`m${i}`, Buffer.from(i === 605 ? [1, 0, 0] : [2, 0, 0]), EMBED_VERSION]);
  }
});
afterEach(() => { _resetDb(); restore(); rmSync(root, { recursive: true, force: true }); });

describe('date filters before candidate limits', () => {
  it('finds the old FTS match beyond 600 stronger matches, with project-key scoping', () => {
    expect(searchMessagesFts('zebrafoo', 600, undefined, undefined, undefined, true).map(r => r.message_id)).not.toContain('m605');
    const rows = searchMessagesFts('zebrafoo', 600, '/different-host/repo', 'session', undefined, true, 'repo-key', 1000, 1000);
    expect(rows.map(r => r.message_id)).toEqual(['m605']);
  });
  it('filters semantic vectors before the score cap, with inclusive bounds', () => {
    const query = new Int8Array([1, 0, 0]);
    expect(searchMessagesSemantic(query, 1, 1, { limit: 600 }).map(r => r.message_id)).not.toContain('m605');
    expect(searchMessagesSemantic(query, 1, 1, { limit: 600, createdFrom: 1000, createdTo: 1000, projectKey: 'repo-key' }).map(r => r.message_id)).toEqual(['m605']);
    expect(searchMessagesSemantic(query, 1, 1, { createdFrom: 1001, createdTo: 1999 })).toEqual([]);
  });
  it('composes one-sided dates with exclusion and the hot-only FTS view', () => {
    expect(searchMessagesFts('zebrafoo', 600, undefined, undefined, 'session', true, undefined, undefined, 1000)).toEqual([]);
    getDb(dbPath()).run("UPDATE messages SET retrieval_class = 'agent' WHERE message_id = 'm605'");
    expect(searchMessagesFts('zebrafoo', 600, undefined, undefined, undefined, true, undefined, undefined, 1000)).toEqual([]);
    expect(searchMessagesFts('zebrafoo', 600, undefined, undefined, undefined, true, undefined, 2001)).toEqual([]);
  });
});


it('uses the same explicit timestamp bounds for list and search', () => {
  const since = '1970-01-01T01:00:01+01:00';
  const until = '1970-01-01T01:00:01+01:00';
  const bounds = parseDateBounds(since, until);
  expect(bounds).toEqual({ createdFrom: 1000, createdTo: 1000 });
  expect(listSessions(dbPath(), 20, since, undefined, undefined, until)[0]?.message_count).toBe(1);
  expect(searchMessagesFts('zebrafoo', 600, undefined, undefined, undefined, true, undefined, bounds.createdFrom, bounds.createdTo).map(r => r.message_id)).toEqual(['m605']);
});

it('keeps a date-only UTC day identical under a non-UTC host timezone', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Toronto';
    const bounds = parseDateBounds('2026-09-06', '2026-09-06');
    expect(bounds.createdFrom).toBe(Date.parse('2026-09-06T00:00:00Z'));
    expect(bounds.createdTo).toBe(Date.parse('2026-09-06T23:59:59.999Z'));
    expect(bounds.createdTo! - bounds.createdFrom!).toBe(86_400_000 - 1);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  expect(() => parseDateBounds(undefined, 'invalid')).toThrow('Invalid --until date');
});
