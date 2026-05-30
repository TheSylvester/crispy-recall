/**
 * Recall Database — SQLite Singleton via node-sqlite3-wasm
 *
 * Owns the Database instance lifecycle: lazy init, pragmas, schema,
 * and clean shutdown.
 *
 * Holds only the recall tables. Adds WAL + busy_timeout +
 * synchronous=NORMAL pragmas because the standalone is multi-process
 * (Stop hook + embed-pending children + CLI + backfill), and the
 * ingest_watermark table for steady-state catch-up (plan §5.4 / §5.14).
 *
 * @module db
 */

import { rmSync, existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';
import type { Database } from 'node-sqlite3-wasm';
import { Database as DatabaseConstructor } from 'node-sqlite3-wasm';

// ============================================================================
// Singleton
// ============================================================================

let db: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Get or create the SQLite database singleton.
 *
 * On first call, opens the database file (creating it if needed),
 * sets concurrency pragmas, and runs schema setup. Subsequent calls
 * return the cached instance if the path matches.
 */
export function getDb(dbPath: string): Database {
  if (db && currentDbPath === dbPath) return db;

  // Close any existing connection before opening a new one
  if (db) {
    closeDb();
  }

  // Ensure the parent directory exists — the standalone has no separate
  // activation step, so getDb is the right hook.
  mkdirSync(dirname(dbPath), { recursive: true });

  // node-sqlite3-wasm uses a directory (${dbPath}.lock) as a filesystem
  // semaphore. If a prior process crashed without calling db.close(), the
  // lock directory is left behind and every subsequent open enters an
  // emscripten busy-wait spin (100% CPU, no recovery).
  //
  // Only remove the lock if the owning process is dead. A live process's
  // lock must never be removed — that defeats the concurrency guard and
  // causes B-tree corruption from unsynchronized concurrent writes.
  clearStaleLock(dbPath);

  // Record ownership before opening the connection. NOTE: the `${dbPath}.lock`
  // directory is NOT created here — node-sqlite3-wasm acquires it transiently
  // per write transaction (its VFS xLock does mkdirSync, xUnlock does rmdirSync),
  // so it exists only while some process is mid-write. clearStaleLock removes a
  // `.lock` left behind by a crashed writer; the `.owner` file (PID + start-token)
  // is what lets it tell a live holder from a dead one. We write the owner before
  // any DB work so this process is identifiable as early as possible; writing it
  // before a `.lock` dir can exist is harmless — clearStaleLock early-returns when
  // there is no `.lock` dir.
  writeOwnerFile(dbPath);
  db = new DatabaseConstructor(dbPath);
  currentDbPath = dbPath;

  // Multi-process concurrency (plan §5.4 / §5.13 justified deviation #1):
  // the standalone has several OS processes hitting the same DB.
  // busy_timeout MUST be set before any other pragma — the journal_mode
  // switch needs an exclusive lock and will fail-fast under contention
  // (Stop hooks fire in parallel) if no timeout is in place yet.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 1000');

  // Enable foreign key enforcement (OFF by default in SQLite)
  db.exec('PRAGMA foreign_keys = ON');

  ensureSchema(db);
  log({ source: 'db', level: 'info', summary: `DB: initialized at ${dbPath}` });

  return db;
}

/**
 * Close the database connection and release the singleton.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    if (currentDbPath) removeOwnerFile(currentDbPath);
    db = null;
    currentDbPath = null;
  }
}

/**
 * Reset for testing — closes the DB so a different path can be opened.
 */
export function _resetDb(): void {
  closeDb();
}

// ============================================================================
// Owner file — tracks which PID holds the DB open
// ============================================================================

function ownerFilePath(dbPath: string): string {
  return `${dbPath}.owner`;
}

/**
 * Best-effort process start-identity token for a PID.
 *
 * Used to defeat PID reuse: a recycled PID belonging to an unrelated live
 * process will not match the token recorded when the lock was taken. On
 * Linux we read field 22 (starttime, in clock ticks since boot) from
 * /proc/<pid>/stat. On any other platform, or on any error (no /proc,
 * permissions, race with process exit), we return '' (unknown), which makes
 * the comparison degrade gracefully to PID-only behavior. Never throws.
 */
function processStartToken(pid: number): string {
  if (process.platform !== 'linux') return '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // comm (field 2) is parenthesized and may contain spaces/parens, so split
    // after the final ')' to keep field indexing stable.
    const close = stat.lastIndexOf(')');
    if (close === -1) return '';
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    // After comm, fields start at #3 (state). starttime is field 22, i.e.
    // index (22 - 3) = 19 into `rest`.
    const starttime = rest[19];
    return starttime ?? '';
  } catch {
    return '';
  }
}

function writeOwnerFile(dbPath: string): void {
  try {
    const token = processStartToken(process.pid);
    writeFileSync(ownerFilePath(dbPath), `${process.pid}:${token}`, 'utf-8');
  } catch {
    // Best-effort
  }
}

function removeOwnerFile(dbPath: string): void {
  try {
    unlinkSync(ownerFilePath(dbPath));
  } catch {
    // Best-effort
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Stale lock cleanup
// ============================================================================

function clearStaleLock(dbPath: string): void {
  const lockDir = `${dbPath}.lock`;
  if (!existsSync(lockDir)) return;

  const ownerFile = ownerFilePath(dbPath);
  if (existsSync(ownerFile)) {
    try {
      // Owner record is `pid:startToken` (token may be empty on non-Linux or
      // when unknown). Backward-compatible with a bare `pid` from older runs.
      const raw = readFileSync(ownerFile, 'utf-8').trim();
      const sep = raw.indexOf(':');
      const pidStr = sep === -1 ? raw : raw.slice(0, sep);
      const storedToken = sep === -1 ? '' : raw.slice(sep + 1);
      const pid = parseInt(pidStr, 10);
      // The owner is only considered ALIVE if the PID is alive AND either the
      // stored token is empty (unknown — degrade to PID-only) or it matches
      // the live process's current start token. A mismatch means the PID was
      // recycled, so the recorded holder is gone and the lock is stale.
      if (!isNaN(pid) && isProcessAlive(pid)) {
        if (storedToken === '' || storedToken === processStartToken(pid)) {
          return;
        }
      }
    } catch {
      // Fall through to remove the lock
    }
  }

  try {
    rmSync(lockDir, { recursive: true, force: true });
    log({
      source: 'db',
      level: 'warn',
      summary: `DB: removed stale lock directory (${lockDir}) — owning process is dead`,
    });
  } catch (err) {
    log({
      source: 'db',
      level: 'error',
      summary: `DB: failed to remove stale lock directory: ${err}`,
    });
  }
}

// ============================================================================
// Schema — recall tables only
// ============================================================================

function ensureSchema(db: Database): void {
  // ====================================================================
  // messages — recall message index
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id    TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      message_seq   INTEGER NOT NULL,
      message_text  TEXT NOT NULL,
      project_id    TEXT,
      created_at    INTEGER NOT NULL,
      message_role  TEXT,
      UNIQUE(session_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
  `);

  // ====================================================================
  // messages_fts — full-text search over messages
  // ====================================================================
  db.exec(`
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
  `);

  // ====================================================================
  // messages_fts_vocab — term statistics for IDF-based query filtering
  // ====================================================================
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab
      USING fts5vocab(messages_fts, 'row');
  `);

  // ====================================================================
  // _stem — helper table to resolve porter stems via FTS5's own tokenizer
  // ====================================================================
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS _stem USING fts5(
      t, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS _stem_vocab
      USING fts5vocab(_stem, 'row');
  `);

  // ====================================================================
  // message_vectors — embedding vectors for semantic search
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id    TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
      embedding_q8  BLOB NOT NULL,
      norm          REAL NOT NULL,
      quant_scale   REAL NOT NULL
    );
  `);

  // ====================================================================
  // ingest_watermark — steady-state catch-up tracking (plan §5.4 / §5.14
  // justified deviation #2). The only documented schema addition for
  // the standalone.
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_watermark (
      transcript_path TEXT PRIMARY KEY,
      last_mtime      INTEGER NOT NULL,
      last_size       INTEGER NOT NULL,
      vendor          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watermark_vendor ON ingest_watermark(vendor);
  `);
}
