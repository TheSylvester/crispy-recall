/**
 * embed_version migration tests.
 *
 * Proves the per-row version migration that backs the nomic task-prefix change:
 * legacy (embed_version = 1) vectors are invisible to the semantic scan — so a
 * QUERY_PREFIX-prefixed query is never scored against bare doc vectors — and are
 * counted as gaps by the "needs embedding" selectors so the normal sweep
 * re-embeds them to the current version. Current-version (2) vectors score
 * normally and are not gaps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import {
  searchMessagesSemantic,
  getUnembeddedMessages,
  getEmbeddingGapStats,
} from '../../src/recall/message-store.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';

let recallHome: string;
let restoreRoot: () => void;

// >= MIN_EMBED_CHARS (50) so the message counts toward the embedding gap.
const LONG_TEXT = 'x'.repeat(60);

function insertMessage(messageId: string, seq: number): void {
  getDb(dbPath()).run(
    `INSERT INTO messages
       (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [messageId, 'sess-1', seq, LONG_TEXT, null, 1000 + seq, 'user'],
  );
}

function insertVector(messageId: string, version: number): void {
  const q8 = new Int8Array([10, 10, 10]);
  getDb(dbPath()).run(
    `INSERT OR REPLACE INTO message_vectors
       (message_id, embedding_q8, norm, quant_scale, embed_version)
     VALUES (?, ?, ?, ?, ?)`,
    [messageId, Buffer.from(q8.buffer, q8.byteOffset, q8.byteLength), 1.0, 1.0, version],
  );
}

describe('embed_version migration', () => {
  beforeEach(() => {
    recallHome = join(tmpdir(), `recall-embedver-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    _resetDb();
    getDb(dbPath()); // open + ensureSchema

    // legacy v1 row (stale) and current v2 row.
    insertMessage('msg-v1', 0);
    insertMessage('msg-v2', 1);
    insertVector('msg-v1', 1);
    insertVector('msg-v2', EMBED_VERSION);
  });

  afterEach(() => {
    restoreRoot?.();
    _resetDb();
    if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
  });

  it('searchMessagesSemantic scores only current-version vectors', () => {
    const queryQ8 = new Int8Array([10, 10, 10]);
    const results = searchMessagesSemantic(queryQ8, 1.0, 1.0, { limit: 10 });
    const ids = results.map((r) => r.message_id);
    expect(ids).toContain('msg-v2');
    expect(ids).not.toContain('msg-v1');
  });

  it('getUnembeddedMessages counts the legacy v1 row as a gap', () => {
    const unembedded = getUnembeddedMessages(10);
    const ids = unembedded.map((m) => m.message_id);
    expect(ids).toContain('msg-v1');
    expect(ids).not.toContain('msg-v2');
  });

  it('getEmbeddingGapStats counts the legacy v1 row as a gap', () => {
    const { totalMessages, gapCount } = getEmbeddingGapStats();
    expect(totalMessages).toBe(2);
    expect(gapCount).toBe(1);
  });
});
