/**
 * FTS5 query sanitizer tests.
 *
 * Covers the documented behaviors of sanitizeFts5Query: empty handling,
 * hyphen/underscore NOT-operator normalization, unbalanced-quote stripping,
 * operator pass-through, the implicit-AND/OR fallbacks, IDF high-frequency
 * term dropping (DB-backed), and quote-injection safety in the FTS5-native
 * stemmer.
 *
 * The 3+ word IDF path queries the live fts5vocab + `_stem` tables, so this
 * runs against a real (sandboxed) DB rather than as a pure unit test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { sanitizeFts5Query } from '../../src/recall/query-sanitizer.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

let recallHome: string;
let restoreRoot: () => void;

/** Insert a message straight into the messages table (FTS triggers populate
 *  messages_fts + vocab automatically). */
function seedMessage(seq: number, text: string): void {
  getDb(dbPath()).run(
    `INSERT INTO messages
       (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`m-${seq}-${randomUUID().slice(0, 8)}`, 'seed-sess', seq, text, null, 1_700_000_000_000 + seq, 'user'],
  );
}

describe('sanitizeFts5Query', () => {
  beforeAll(() => {
    recallHome = join(tmpdir(), `recall-sanitizer-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    _resetDb();
    getDb(dbPath()); // force schema creation (messages_fts, _stem, vocab)
  });

  afterAll(() => {
    restoreRoot?.();
    _resetDb();
    if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
  });

  describe('empty / trivial', () => {
    it('returns null for empty or whitespace-only input', () => {
      expect(sanitizeFts5Query('')).toBeNull();
      expect(sanitizeFts5Query('   ')).toBeNull();
      expect(sanitizeFts5Query('\t \n')).toBeNull();
    });

    it('passes a single word through unquoted', () => {
      expect(sanitizeFts5Query('hello')).toBe('hello');
    });

    it('wraps two words as implicit AND (quoted tokens)', () => {
      expect(sanitizeFts5Query('foo bar')).toBe('"foo" "bar"');
    });
  });

  describe('hyphen / underscore normalization (the NOT-operator trap)', () => {
    it('splits an inter-word hyphen into two AND tokens, not a NOT', () => {
      // Raw FTS5 would read `claude-transcript` as "claude NOT transcript".
      expect(sanitizeFts5Query('claude-transcript')).toBe('"claude" "transcript"');
    });

    it('splits an inter-word underscore the same way', () => {
      expect(sanitizeFts5Query('foo_bar')).toBe('"foo" "bar"');
    });
  });

  describe('quotes', () => {
    it('strips an unbalanced quote and recovers the bare term', () => {
      expect(sanitizeFts5Query('foo"bar')).toBe('foobar');
    });

    it('preserves a balanced quoted phrase', () => {
      expect(sanitizeFts5Query('"hello world"')).toBe('"hello world"');
    });
  });

  describe('operators and special characters', () => {
    it('passes recognized FTS5 operators through', () => {
      const out = sanitizeFts5Query('foo OR bar');
      expect(out).toContain('OR');
      expect(out).toContain('foo');
      expect(out).toContain('bar');
    });

    it('strips FTS5 special characters in the fallback path', () => {
      // 3+ bare words with parens → special chars dropped, OR query built.
      const out = sanitizeFts5Query('foo (bar) baz');
      expect(out).not.toBeNull();
      expect(out).not.toMatch(/[()]/);
      expect(out).toContain('foo');
      expect(out).toContain('bar');
      expect(out).toContain('baz');
    });
  });

  describe('IDF high-frequency dropping (DB-backed)', () => {
    it('drops a term present in >15% of indexed messages', () => {
      // 10 messages all containing "common" → df = 1.0, far above the 0.15
      // threshold. The rare terms appear in zero messages → df = 0, kept.
      for (let i = 0; i < 10; i++) seedMessage(i, `common shared text number ${i}`);

      const out = sanitizeFts5Query('common zorptangle wibblenax');
      expect(out).not.toBeNull();
      expect(out!.toLowerCase()).not.toContain('common');
      expect(out!.toLowerCase()).toContain('zorptangle');
      expect(out!.toLowerCase()).toContain('wibblenax');
    });
  });

  describe('stemmer quote-injection safety', () => {
    it('does not throw on an apostrophe-bearing term (3+ word IDF path)', () => {
      // fts5Stem inserts the word into _stem via string-concatenated SQL with
      // '' escaping — a stray apostrophe must not break the query.
      let out: string | null = null;
      expect(() => { out = sanitizeFts5Query("it's working here"); }).not.toThrow();
      expect(out).not.toBeNull();
    });
  });
});
