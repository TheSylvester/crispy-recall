/**
 * Recall Database — SQLite Singleton via better-sqlite3 (native, real WAL)
 *
 * Owns the Database instance lifecycle: lazy init, pragmas, schema,
 * and clean shutdown.
 *
 * Holds only the recall tables. Adds real WAL + busy_timeout +
 * synchronous=NORMAL pragmas because the standalone is multi-process
 * (Stop hook + embed-pending children + CLI + backfill), and the
 * ingest_watermark table for steady-state catch-up (plan §5.4 / §5.14).
 *
 * The binding is exposed through a thin driver adapter (`RecallDb`) whose
 * surface — `all/get/run/exec/prepare/close` — matches the historic internal
 * shape, so call sites migrate mechanically and a node:sqlite adapter stays
 * drop-in later. Array binds are normalized to positional varargs via SPREAD
 * (both here and in the prepared-statement wrapper) so both drivers are
 * interchangeable (node:sqlite statements do not accept a single array arg).
 *
 * @module db
 */

import { rmSync, existsSync, unlinkSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { log } from './log.js';
import { binDir } from './paths.js';
import Database from 'better-sqlite3';

type RawDatabase = Database.Database;

// ============================================================================
// Driver adapter surface
// ============================================================================

/** A compiled statement wrapped so it accepts positional binds as one array. */
export interface RecallStatement {
  run(params?: unknown[]): unknown;
  all(params?: unknown[]): any[];
  get(params?: unknown[]): any;
}

/**
 * The internal DB surface every call site uses. Kept deliberately narrow and
 * driver-neutral (better-sqlite3 today, node:sqlite is the pre-planned exit).
 */
export interface RecallDb {
  all(sql: string, params?: unknown[]): any[];
  get(sql: string, params?: unknown[]): any;
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string): void;
  prepare(sql: string): RecallStatement;
  close(): void;
}

/**
 * Typed error for a failed native-binding load (ABI mismatch, missing
 * `better_sqlite3.node`, dlopen failure). Callers act on it: the Stop hook
 * fails soft (exits 0 + breadcrumb) so a broken binding never blocks Claude
 * Code; the CLI prints an actionable message naming `recall doctor`.
 */
export class BindingLoadError extends Error {
  constructor(public readonly dbPath: string, public readonly cause: Error) {
    super(
      `recall: failed to load the better-sqlite3 native binding while opening ${dbPath}: ` +
        `${cause.message}\n` +
        'The native SQLite binding is ABI-locked to the Node it was built for. This is usually one of:\n' +
        '  • recall is running under a different Node than the one npm installed it with ' +
        '(e.g. Homebrew node vs nvm) — reinstall with `npm install -g crispy-recall` using the node on ' +
        'your PATH, then `recall install`.\n' +
        '  • no prebuilt binary matched your Node version and it could not compile — use Node 22 LTS or ' +
        '24+ (Node 23 has no prebuilt SQLite binding), and on macOS make sure Xcode Command Line Tools ' +
        'are installed (`xcode-select --install`).\n' +
        'Run `recall doctor` for details.',
    );
    this.name = 'BindingLoadError';
  }
}

/** Heuristic: does this error look like a native-binding load failure? */
export function isBindingLoadError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return /NODE_MODULE_VERSION|different Node\.?js version|dlopen|invalid ELF|not a valid Win32 application|better_sqlite3\.node|Could not locate the bindings|was compiled against/i.test(
    msg,
  );
}

// ============================================================================
// Singleton
// ============================================================================

let db: RecallDb | null = null;
let currentDbPath: string | null = null;

/**
 * Get or create the SQLite database singleton.
 *
 * On first call, opens the database file (creating it if needed),
 * sets concurrency pragmas, and runs schema setup. Subsequent calls
 * return the cached instance if the path matches.
 */
export function getDb(dbPath: string): RecallDb {
  if (db && currentDbPath === dbPath) return db;

  // Close any existing connection before opening a new one
  if (db) {
    closeDb();
  }

  // Ensure the parent directory exists — the standalone has no separate
  // activation step, so getDb is the right hook.
  mkdirSync(dirname(dbPath), { recursive: true });

  // One-time hygiene: sweep away any leftover node-sqlite3-wasm lock dir and
  // owner file from the wasm era. better-sqlite3 uses POSIX/Win32 advisory
  // locks and never creates these; removing them is always safe and harmless
  // if absent.
  cleanupWasmArtifacts(dbPath);

  const raw = openDatabase(dbPath);
  try {
    configurePragmas(raw, dbPath);
  } catch (e) {
    // configurePragmas can throw (notably the WAL-flip assert). A caller may now
    // catch-and-continue in-process (the installer's WAL-flip remediation), so
    // close the orphaned handle instead of leaking it: on Windows a live handle
    // holds the DB file open and blocks the snapshot/rename during a busy abort.
    raw.close();
    throw e;
  }

  db = createAdapter(raw);
  currentDbPath = dbPath;

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
// Binding open + adapter
// ============================================================================

function openDatabase(dbPath: string): RawDatabase {
  // Resolve the better-sqlite3 native addon EXPLICITLY and pass it as
  // `nativeBinding`. This is load-bearing: build.mjs bundles better-sqlite3 AND
  // its `bindings` helper into the CLI (`external: []`), and that bundled
  // `bindings` resolver only searches paths rooted at the crispy-recall package
  // dir — it never consults `node_modules/better-sqlite3`. So relying on
  // better-sqlite3's default resolution bricks `recall` on every platform the
  // moment the builder's sibling `.node` is stripped from the published tarball
  // (which is exactly what `prepublishOnly` does). An explicit nativeBinding is
  // also a *runtime* path, so esbuild never sees a static `.node` import and
  // needs no `.node` loader.
  //
  // `resolveNativeBinding()` returns non-null for every real layout: the
  // installed/bundled ones via candidates 1–3, and even the un-bundled dev/test
  // path via candidate 2 (createRequire resolves the repo's node_modules). The
  // bare `new Database` below is a defensive last resort — in the published
  // bundle a candidate always resolves, and where the bare path *does* run
  // (un-bundled) `require` is Node's real resolver, never the bricking bundled
  // one. If nothing resolves at all, better-sqlite3 raises → BindingLoadError.
  const nativeBinding = resolveNativeBinding();
  try {
    return nativeBinding
      ? new Database(dbPath, { nativeBinding })
      : new Database(dbPath);
  } catch (e) {
    if (isBindingLoadError(e)) throw new BindingLoadError(dbPath, e as Error);
    throw e;
  }
}

/**
 * Resolve the better-sqlite3 native addon through an ordered candidate chain,
 * returning an absolute path or null if none resolves:
 *
 *   1. sibling of the running bundle — `join(__dirname, 'better_sqlite3.node')`.
 *      Covers the local dev build (build.mjs stages `dist/better_sqlite3.node`)
 *      and the installed bundles staged in `~/.recall/bin` (their __dirname).
 *   2. the installer's own `node_modules/better-sqlite3`, via Node's real module
 *      resolution — covers the npm-global layout, where the published tarball
 *      ships NO sibling `.node` but the addon is a resolvable dependency. This
 *      is the case the stripped-tarball publish blocker turned on.
 *   3. `join(binDir(), 'better_sqlite3.node')` — the staged addon in
 *      `~/.recall/bin`, for a bundle whose own __dirname has no sibling.
 */
function resolveNativeBinding(): string | null {
  const sibling = join(__dirname, 'better_sqlite3.node');
  if (existsSync(sibling)) return sibling;

  const resolved = resolveInstalledBinding();
  if (resolved) return resolved;

  const staged = join(binDir(), 'better_sqlite3.node');
  if (existsSync(staged)) return staged;

  return null;
}

/**
 * Resolve the installed better-sqlite3 addon via Node's real module resolution
 * (respects hoisting), then locate its compiled `.node`. Mirrors the installer's
 * own staging resolver (`install.ts` resolveInstalledBinding) — kept local here
 * rather than shared because the installer already imports this module, and a
 * back-import would create a db↔installer cycle.
 */
function resolveInstalledBinding(): string | null {
  try {
    const pkgJson = createRequire(__filename).resolve('better-sqlite3/package.json');
    return findNativeBinding(dirname(pkgJson));
  } catch {
    return null;
  }
}

/** Find better_sqlite3.node under a package dir: canonical gyp output first,
 *  then a bounded recursive scan (covers prebuild-install `prebuilds/…`). */
function findNativeBinding(baseDir: string): string | null {
  for (const c of [
    join(baseDir, 'build', 'Release', 'better_sqlite3.node'),
    join(baseDir, 'build', 'Debug', 'better_sqlite3.node'),
  ]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.node')) return p;
    }
  }
  return null;
}

function createAdapter(raw: RawDatabase): RecallDb {
  return {
    all: (sql, params) => raw.prepare(sql).all(...(params ?? [])),
    get: (sql, params) => raw.prepare(sql).get(...(params ?? [])),
    run: (sql, params) => raw.prepare(sql).run(...(params ?? [])),
    exec: (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const st = raw.prepare(sql);
      return {
        run: (p) => st.run(...(p ?? [])),
        all: (p) => st.all(...(p ?? [])),
        get: (p) => st.get(...(p ?? [])),
      };
    },
    close: () => raw.close(),
  };
}

function configurePragmas(raw: RawDatabase, dbPath: string): void {
  // A `:memory:` DB legitimately reports 'memory' and can never be WAL — the
  // one non-WAL case we must not throw on.
  const isMemory =
    dbPath === ':memory:' || dbPath.includes(':memory:') || dbPath.startsWith('file::memory:');

  // busy_timeout first: the WAL switch needs an exclusive lock and would fail
  // fast under contention (parallel Stop hooks) without a timeout already in
  // place. (better-sqlite3 defaults to 5000 ms anyway; set it explicitly.)
  raw.pragma('busy_timeout = 5000');

  // journal_mode=WAL is now REAL. Read the return value and ASSERT it — the
  // wasm binding silently ran in delete mode for months because SQLite returns
  // the old mode instead of erroring when the switch is impossible. Never again.
  const mode = raw.pragma('journal_mode = WAL', { simple: true });
  if (!isMemory && mode !== 'wal') {
    throw new Error(
      `recall: expected WAL journal_mode, got '${String(mode)}' — refusing to run on a ` +
        `non-WAL DB (${dbPath}). A native build on a delete-mode DB is drift; run \`recall doctor\`.`,
    );
  }

  raw.pragma('synchronous = NORMAL');
  raw.pragma('wal_autocheckpoint = 1000');
  raw.pragma('foreign_keys = ON');
}

/** Remove a leftover wasm-era `${dbPath}.lock` dir and `${dbPath}.owner` file. */
function cleanupWasmArtifacts(dbPath: string): void {
  try {
    rmSync(`${dbPath}.lock`, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    if (existsSync(`${dbPath}.owner`)) unlinkSync(`${dbPath}.owner`);
  } catch {
    // best-effort
  }
}

// ============================================================================
// Schema — recall tables only
// ============================================================================

function ensureSchema(db: RecallDb): void {
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
    -- getUnembeddedMessages() orders the whole table by created_at DESC (LIMIT N).
    -- Without a standalone created_at index SQLite full-scans messages and builds
    -- a TEMP B-TREE to sort on every call — a ~4s/batch cost that dominates the
    -- embed drain and every Stop-hook catch-up. This index serves the ORDER BY so
    -- the planner walks it and early-terminates at LIMIT instead.
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
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
      quant_scale   REAL NOT NULL,
      embed_version INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Idempotent, race-safe migration for existing DBs: add embed_version if
  // absent. ensureSchema runs inside getDb(), which several processes (parallel
  // Stop hooks, embed-pending, CLI, backfill) hit at once, so the ALTER can lose
  // a race two ways — another process already added the column ("duplicate
  // column name"), or the writer lock is contended (SQLITE_BUSY/"database is
  // locked"). On ANY failure, re-check table_info: treat it as success if the
  // column now exists; only throw if it genuinely still isn't there.
  const hasEmbedVersion = () =>
    (db.all(`PRAGMA table_info(message_vectors)`) as Array<{ name: string }>)
      .some((c) => c.name === 'embed_version');
  if (!hasEmbedVersion()) {
    try {
      db.exec(`ALTER TABLE message_vectors ADD COLUMN embed_version INTEGER NOT NULL DEFAULT 1`);
    } catch (e) {
      // A racing process may have added it, or the lock was contended. Re-check;
      // only surface the error if the column genuinely isn't there.
      if (!hasEmbedVersion()) throw e;
    }
  }

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
