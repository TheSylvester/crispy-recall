/**
 * §4.2 proof — filtered external-content FTS5 behavior on the repo's bundled
 * SQLite build, isolated from the production code paths.
 *
 * Verifies, empirically, everything the retrieval-class design leans on:
 *   - an FTS5 table with content=<view> works for insert/query/delete
 *   - the four-state triggers produce the right index for every transition
 *   - 'rebuild' repopulates from the FILTERED view (agent rows stay out)
 *   - the rank-1 integrity-check form REJECTS a view/index mismatch that the
 *     rank-less form silently passes (why every repair path must use rank-1)
 *   - the full migration DDL sequence (drop triggers → drop vocab → drop fts →
 *     classify → create view/triggers/vocab → rebuild → integrity-check) holds
 *     inside ONE transaction, and a mid-sequence ROLLBACK restores the old
 *     schema intact (crash safety)
 *   - the OLD (pre-migration) ensureSchema DDL run against the NEW schema
 *     creates nothing (same object names → IF NOT EXISTS no-ops)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;

const NEW_TABLES = `
  CREATE TABLE IF NOT EXISTS messages (
    message_id      TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    message_seq     INTEGER NOT NULL,
    message_text    TEXT NOT NULL,
    project_id      TEXT,
    created_at      INTEGER NOT NULL,
    message_role    TEXT,
    retrieval_class TEXT NOT NULL DEFAULT 'hot',
    UNIQUE(session_id, message_id)
  );
`;

const NEW_FTS = `
  CREATE VIEW IF NOT EXISTS searchable_messages AS
    SELECT rowid, message_text FROM messages WHERE retrieval_class = 'hot';

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_text,
    content=searchable_messages,
    content_rowid=rowid,
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
    WHEN new.retrieval_class = 'hot'
  BEGIN
    INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
    WHEN old.retrieval_class = 'hot'
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, message_text)
    VALUES ('delete', old.rowid, old.message_text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, message_text)
      SELECT 'delete', old.rowid, old.message_text WHERE old.retrieval_class = 'hot';
    INSERT INTO messages_fts(rowid, message_text)
      SELECT new.rowid, new.message_text WHERE new.retrieval_class = 'hot';
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab
    USING fts5vocab(messages_fts, 'row');
`;

/** The PRE-migration schema objects, verbatim from the old db.ts. */
const OLD_FTS = `
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
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab
    USING fts5vocab(messages_fts, 'row');
`;

function insertMsg(id: string, text: string, cls: 'hot' | 'agent'): void {
  db.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at, retrieval_class)
     VALUES (?, 's', (SELECT COALESCE(MAX(message_seq),0)+1 FROM messages), ?, 0, ?)`,
  ).run(id, text, cls);
}

function ftsHits(term: string): string[] {
  return (db.prepare(
    `SELECT m.message_id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
     WHERE messages_fts MATCH ? ORDER BY m.message_id`,
  ).all(term) as Array<{ message_id: string }>).map((r) => r.message_id);
}

function integrityRank1(): { ok: boolean; error?: string } {
  try {
    db.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1);`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function integrityRankless(): { ok: boolean; error?: string } {
  try {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(NEW_TABLES);
  db.exec(NEW_FTS);
});

afterEach(() => {
  db.close();
});

describe('filtered external-content FTS5 (view-backed)', () => {
  it('insert triggers: hot rows indexed, agent rows not', () => {
    insertMsg('h1', 'hot walrus content', 'hot');
    insertMsg('a1', 'agent walrus content', 'agent');
    expect(ftsHits('walrus')).toEqual(['h1']);
  });

  it('delete triggers: hot delete removes index row; agent delete is a no-op', () => {
    insertMsg('h1', 'hot walrus', 'hot');
    insertMsg('a1', 'agent walrus', 'agent');
    db.prepare(`DELETE FROM messages WHERE message_id = 'h1'`).run();
    db.prepare(`DELETE FROM messages WHERE message_id = 'a1'`).run();
    expect(ftsHits('walrus')).toEqual([]);
    expect(integrityRank1().ok).toBe(true);
  });

  it('update triggers cover all four class transitions', () => {
    insertMsg('m1', 'walrus one', 'hot');
    insertMsg('m2', 'walrus two', 'agent');

    // hot→hot (text change) → old deleted, new indexed
    db.prepare(`UPDATE messages SET message_text = 'narwhal one' WHERE message_id = 'm1'`).run();
    expect(ftsHits('walrus')).toEqual([]);
    expect(ftsHits('narwhal')).toEqual(['m1']);

    // hot→agent → delete only
    db.prepare(`UPDATE messages SET retrieval_class = 'agent' WHERE message_id = 'm1'`).run();
    expect(ftsHits('narwhal')).toEqual([]);

    // agent→hot → insert only
    db.prepare(`UPDATE messages SET retrieval_class = 'hot' WHERE message_id = 'm2'`).run();
    expect(ftsHits('walrus')).toEqual(['m2']);

    // agent→agent → no-op
    db.prepare(`UPDATE messages SET message_text = 'silent change' WHERE message_id = 'm1'`).run();
    expect(ftsHits('silent')).toEqual([]);

    expect(integrityRank1().ok).toBe(true);
  });

  it("'rebuild' repopulates from the FILTERED view only", () => {
    insertMsg('h1', 'hot walrus', 'hot');
    insertMsg('h2', 'hot narwhal', 'hot');
    insertMsg('a1', 'agent walrus', 'agent');
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
    expect(ftsHits('walrus')).toEqual(['h1']);
    expect(ftsHits('narwhal')).toEqual(['h2']);
    expect(integrityRank1().ok).toBe(true);
  });

  it('rank-1 integrity-check REJECTS a view/index mismatch that the rank-less form passes', () => {
    insertMsg('h1', 'hot walrus', 'hot');
    // Create a deliberate mismatch: flip the row to agent WITHOUT firing the
    // triggers (direct shadow-state divergence): drop triggers, flip, restore.
    db.exec('DROP TRIGGER messages_fts_au');
    db.prepare(`UPDATE messages SET retrieval_class = 'agent' WHERE message_id = 'h1'`).run();
    // Index still contains h1; the view no longer exposes it → mismatch.
    const rankless = integrityRankless();
    expect(rankless.ok, 'rank-less integrity-check silently passes on external-content mismatch').toBe(true);
    const rank1 = integrityRank1();
    expect(rank1.ok, 'rank-1 integrity-check must detect the mismatch').toBe(false);
  });

  it('rank-1 integrity-check passes across trigger-mediated hot↔agent flips', () => {
    for (let i = 0; i < 10; i++) insertMsg(`m${i}`, `text number ${i} walrus`, i % 2 ? 'hot' : 'agent');
    db.exec(`UPDATE messages SET retrieval_class = CASE retrieval_class WHEN 'hot' THEN 'agent' ELSE 'hot' END`);
    expect(integrityRank1().ok).toBe(true);
    db.exec(`UPDATE messages SET retrieval_class = 'hot'`);
    expect(integrityRank1().ok).toBe(true);
  });
});

describe('migration DDL sequence (transactional)', () => {
  /** Build the OLD-generation schema with mixed data, as a migration input. */
  function buildOldGen(): void {
    db.close();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        message_id   TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        message_seq  INTEGER NOT NULL,
        message_text TEXT NOT NULL,
        project_id   TEXT,
        created_at   INTEGER NOT NULL,
        message_role TEXT,
        UNIQUE(session_id, message_id)
      );
    `);
    db.exec(OLD_FTS);
    const ins = db.prepare(
      `INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at) VALUES (?, ?, ?, ?, 0)`,
    );
    ins.run('root-1', 'root-session', 0, 'parent narration about walrus refactor');
    ins.run('leaf-1', 'agent-abc12345', 0, 'leaf progress about walrus internals');
    ins.run('leaf-2', 'agent-abc12345', 1, 'leaf final answer walrus');
  }

  /** The exact drop→classify→recreate→rebuild sequence the migration runs. */
  function migrationSequence(): void {
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_au');
    db.exec('DROP TABLE IF EXISTS messages_fts_vocab');
    db.exec('DROP TABLE IF EXISTS messages_fts');
    db.exec(`ALTER TABLE messages ADD COLUMN retrieval_class TEXT NOT NULL DEFAULT 'hot'`);
    db.exec(`UPDATE messages SET retrieval_class = 'agent' WHERE session_id LIKE 'agent-%'`);
    db.exec(NEW_FTS);
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
    db.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1);`);
  }

  it('the full sequence works inside one transaction and excludes agent rows', () => {
    buildOldGen();
    db.exec('BEGIN IMMEDIATE');
    migrationSequence();
    db.exec('COMMIT');
    expect(ftsHits('walrus')).toEqual(['root-1']);
    // Text preserved byte-for-byte for the cold rows.
    const leaf = db.prepare(`SELECT message_text FROM messages WHERE message_id = 'leaf-2'`).get() as { message_text: string };
    expect(leaf.message_text).toBe('leaf final answer walrus');
  });

  it('a mid-sequence ROLLBACK restores the old schema and index intact (crash safety)', () => {
    buildOldGen();
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_au');
    db.exec('DROP TABLE IF EXISTS messages_fts_vocab');
    db.exec('DROP TABLE IF EXISTS messages_fts');
    db.exec('ROLLBACK');
    // Old unfiltered index is back and functional — all three rows searchable.
    expect(ftsHits('walrus')).toEqual(['leaf-1', 'leaf-2', 'root-1']);
    // Old triggers still live.
    const trg = db.prepare(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts_%'`,
    ).get() as { c: number };
    expect(trg.c).toBe(3);
  });

  it('the OLD ensureSchema DDL against the NEW schema creates nothing (pinned names no-op)', () => {
    buildOldGen();
    db.exec('BEGIN IMMEDIATE');
    migrationSequence();
    db.exec('COMMIT');

    const objectsBefore = db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    db.exec(OLD_FTS); // an older binary's CREATE … IF NOT EXISTS pass
    const objectsAfter = db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    expect(objectsAfter).toEqual(objectsBefore);
    // And the filtered semantics still hold.
    expect(ftsHits('walrus')).toEqual(['root-1']);
  });
});
