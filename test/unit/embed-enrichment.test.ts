/**
 * Adjacency context-enrichment + relaxed embed floor tests.
 *
 * Proves the two embed-input changes behind EMBED_VERSION 3:
 *  1. getUnembeddedMessages prepends the immediately-preceding turn's text to the
 *     embed INPUT of short messages (buildEmbedText), while long messages embed
 *     as-is. Stored message_text is never mutated.
 *  2. The embed floor is relaxed (MIN_EMBED_CHARS 50 -> 0): a sub-50-char message
 *     is now returned by getUnembeddedMessages whereas before it was excluded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { getUnembeddedMessages } from '../../src/recall/message-store.js';

let recallHome: string;
let restoreRoot: () => void;

// A long-ish preceding turn (>= ENRICH_MAX_CHARS 200) — its own embed_text is
// unprepended, and it serves as the context source for the short turn after it.
const PREV_TEXT =
  'Earlier we configured the database migration and the embedding pipeline in full detail across several files. '.repeat(3);
// A short turn: < ENRICH_MAX_CHARS (200) AND < the old MIN_EMBED_CHARS (50).
const SHORT_TEXT = 'Running';

function insertMessage(messageId: string, seq: number, text: string): void {
  getDb(dbPath()).run(
    `INSERT INTO messages
       (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [messageId, 'sess-1', seq, text, null, 1000 + seq, seq % 2 === 0 ? 'user' : 'assistant'],
  );
}

describe('embed context-enrichment + relaxed floor', () => {
  beforeEach(() => {
    recallHome = join(tmpdir(), `recall-enrich-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    _resetDb();
    getDb(dbPath()); // open + ensureSchema

    insertMessage('msg-prev', 0, PREV_TEXT); // long preceding turn
    insertMessage('msg-short', 1, SHORT_TEXT); // short turn that gets enriched
  });

  afterEach(() => {
    restoreRoot?.();
    _resetDb();
    if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
  });

  it('prepends the preceding turn to a short message embed input', () => {
    const byId = new Map(getUnembeddedMessages(10).map((m) => [m.message_id, m]));

    const short = byId.get('msg-short');
    expect(short).toBeDefined();
    // PREV_TEXT < 512 chars, so slice(-512) is the whole preceding turn.
    expect(short!.embed_text).toBe(PREV_TEXT.slice(-512) + '\n' + SHORT_TEXT);
    // Stored text is byte-for-byte unchanged — only the embed input is enriched.
    expect(short!.message_text).toBe(SHORT_TEXT);
  });

  it('leaves a long message embed input as its own text (no prepend)', () => {
    const byId = new Map(getUnembeddedMessages(10).map((m) => [m.message_id, m]));

    const prev = byId.get('msg-prev');
    expect(prev).toBeDefined();
    expect(prev!.embed_text).toBe(PREV_TEXT);
  });

  it('returns an enrichable sub-50-char message (floor relaxed for enrichable turns)', () => {
    // SHORT_TEXT is 7 chars — under the old MIN_EMBED_CHARS (50) floor it would have
    // been excluded entirely. It is now returned because it is ENRICHABLE: it has a
    // preceding turn (msg-prev) whose context buildEmbedText prepends.
    const ids = getUnembeddedMessages(10).map((m) => m.message_id);
    expect(ids).toContain('msg-short');
  });

  it('skips a context-less short message (short AND no preceding turn)', () => {
    // A short first-turn message has no context to enrich from, so it stays out of
    // the pipeline — we never embed context-less trivia.
    getDb(dbPath()).run(
      `INSERT INTO messages
         (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['msg-orphan', 'sess-2', 0, 'ok', null, 2000, 'user'],
    );
    const ids = getUnembeddedMessages(10).map((m) => m.message_id);
    expect(ids).not.toContain('msg-orphan');
  });
});
