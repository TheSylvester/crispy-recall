/**
 * embed_version migration tests.
 *
 * Proves the per-row version migration that backs the nomic task-prefix change:
 * by default (hard filter) legacy (embed_version = 1) vectors are invisible to
 * the semantic scan — so a QUERY_PREFIX-prefixed query is never scored against
 * bare doc vectors — and are counted as gaps by the "needs embedding" selectors
 * so the normal sweep re-embeds them to the current version. Current-version
 * (EMBED_VERSION = 3) vectors score normally and are not gaps.
 *
 * The second describe block proves the coverage-based tolerant transitional
 * scoring that keeps semantic search alive during a re-embed: below 0.95 coverage
 * stale-version vectors ARE scored (blackout fix), a dimension guard skips
 * length-mismatched stale vectors, and getEmbedVersionStats reports coverage.
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
  getEmbedVersionStats,
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

// ---------------------------------------------------------------------------
// Coverage-based transitional (tolerant) scoring.
//
// Own temp-root lifecycle + local fixtures so the shared 2-row beforeEach above
// (which the hard-filter / gap tests depend on) is never disturbed. Reuses the
// module-level insertMessage helper; adds a dims-aware vector inserter so the
// dimension-guard case can plant length-mismatched stale rows.
// ---------------------------------------------------------------------------
describe('embed_version transitional scoring', () => {
  let home: string;
  let restore: () => void;

  beforeEach(() => {
    home = join(tmpdir(), `recall-embedver-tol-${randomUUID()}`);
    mkdirSync(home, { recursive: true });
    restore = _setTestRoot(home);
    _resetDb();
    getDb(dbPath()); // open + ensureSchema
  });

  afterEach(() => {
    restore?.();
    _resetDb();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  // Insert a vector with an explicit q8 length (default 3, matching the query),
  // so the dim-guard test can plant shorter/longer stale vectors.
  function insertVecDims(messageId: string, version: number, dims = 3): void {
    const q8 = new Int8Array(dims).fill(10);
    getDb(dbPath()).run(
      `INSERT OR REPLACE INTO message_vectors
         (message_id, embedding_q8, norm, quant_scale, embed_version)
       VALUES (?, ?, ?, ?, ?)`,
      [messageId, Buffer.from(q8.buffer, q8.byteOffset, q8.byteLength), 1.0, 1.0, version],
    );
  }

  const QUERY = new Int8Array([10, 10, 10]); // 3-dim synthetic query — no embedder needed

  it('(a) tolerant mode scores stale v1 vectors — the blackout fix', () => {
    // All-v1 fixture = the production condition (coverage 0).
    for (let i = 0; i < 3; i++) {
      insertMessage(`m${i}`, i);
      insertVecDims(`m${i}`, 1);
    }
    expect(getEmbedVersionStats().coverage).toBe(0);

    // Default (hard filter) → v3-only → nothing → blackout.
    const hard = searchMessagesSemantic(QUERY, 1.0, 1.0, { limit: 10 });
    expect(hard).toHaveLength(0);

    // Tolerant → stale v1 vectors scored → semantic results present.
    const tol = searchMessagesSemantic(QUERY, 1.0, 1.0, { limit: 10, tolerant: true });
    expect(tol.length).toBeGreaterThan(0);
    expect(tol.every((r) => Number.isFinite(r.rank))).toBe(true);
  });

  it('(b) hard filter (default) excludes stale rows at coverage 0.95', () => {
    // 19 current + 1 stale = coverage exactly 0.95 → dualPathSearch would NOT go
    // tolerant; assert the default hard filter excludes the stale row.
    for (let i = 0; i < 19; i++) {
      insertMessage(`cur${i}`, i);
      insertVecDims(`cur${i}`, EMBED_VERSION);
    }
    insertMessage('stale', 100);
    insertVecDims('stale', 1);
    expect(getEmbedVersionStats().coverage).toBeCloseTo(0.95, 10);

    const ids = searchMessagesSemantic(QUERY, 1.0, 1.0, { limit: 50 }).map((r) => r.message_id);
    expect(ids).not.toContain('stale');
    expect(ids).toContain('cur0');
  });

  it('(c) tolerant mode skips dim-mismatch stale rows (no error, no NaN)', () => {
    insertMessage('ok', 0);
    insertVecDims('ok', 1, 3); // matches the 3-dim query
    insertMessage('badshort', 1);
    insertVecDims('badshort', 1, 2); // shorter → would NaN without the guard
    insertMessage('badlong', 2);
    insertVecDims('badlong', 1, 5); // longer → silently wrong without the guard

    const results = searchMessagesSemantic(QUERY, 1.0, 1.0, { limit: 10, tolerant: true });
    const ids = results.map((r) => r.message_id);
    expect(ids).toContain('ok');
    expect(ids).not.toContain('badshort');
    expect(ids).not.toContain('badlong');
    expect(results.every((r) => Number.isFinite(r.rank))).toBe(true); // no NaN score leaked
  });

  it('(d) getEmbedVersionStats arithmetic: empty, all-current, mixed', () => {
    // Empty table → SUM over zero rows is NULL → coalesced to 0 → coverage 1.
    expect(getEmbedVersionStats()).toEqual({ total: 0, current: 0, stale: 0, coverage: 1 });

    // All-current → coverage 1.
    insertMessage('a', 0); insertVecDims('a', EMBED_VERSION);
    insertMessage('b', 1); insertVecDims('b', EMBED_VERSION);
    expect(getEmbedVersionStats()).toEqual({ total: 2, current: 2, stale: 0, coverage: 1 });

    // Mixed → fractional coverage.
    insertMessage('c', 2); insertVecDims('c', 1);
    const mixed = getEmbedVersionStats();
    expect(mixed.total).toBe(3);
    expect(mixed.current).toBe(2);
    expect(mixed.stale).toBe(1);
    expect(mixed.coverage).toBeCloseTo(2 / 3, 10);
  });
});
