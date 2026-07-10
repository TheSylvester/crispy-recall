/**
 * upgrade-migrate — safe in-place upgrade of a legacy recall DB.
 *
 * An existing npm user upgrading from the old node-sqlite3-wasm / delete-mode /
 * `embed_version = 1` build to the native better-sqlite3 / WAL / `embed_version = 3`
 * build must NOT get a half-converted DB, a silent semantic blackout, or a crash
 * on pre-existing corruption. Unlike the operator's own box (clean-rebuilt from
 * JSONL elsewhere), an arbitrary user's JSONL may be pruned, so the DB is
 * migrated *in place*: classify → quiesce → snapshot → let the native binding
 * flip it to WAL → integrity-check → launch a gated background re-embed that the
 * already-shipped transitional scoring (message-store.ts / vector-search.ts)
 * keeps queryable throughout.
 *
 * These are pure helpers consumed by install.ts around phases 6–8; the phase
 * order and abort handling live there.
 *
 * @module installer/upgrade-migrate
 */

import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDb, _resetDb } from '../db.js';
import { dbPath, binDir, runDir } from '../paths.js';
import { EMBED_VERSION } from '../recall/embed-config.js';
import { backupStamp } from './settings-merge.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Classification (read-only, BEFORE the native open)
// ---------------------------------------------------------------------------

export type UpgradeState = 'fresh' | 'already-migrated' | 'needs-migration';

export interface UpgradeClassification {
  state: UpgradeState;
  /** Live DB journal mode read read-only (null if DB absent / binding unreadable). */
  journalMode: string | null;
  /** `.binding-info.json` present at classification time (absent = wasm-era install). */
  markerPresent: boolean;
  /** Fraction of vectors at EMBED_VERSION (1 when the table is empty/unreadable). */
  coverage: number;
}

/**
 * Open the live DB read-only without flipping its journal mode. A readonly
 * connection can never write, so it never converts a delete-mode DB — the same
 * discipline `recall doctor` uses. Mirrors the staged-binding-first resolution
 * (bundled runtime has no node_modules) and degrades to null on any failure so
 * the caller can safely assume `needs-migration`.
 */
function openReadonly(dbFile: string): Database.Database | null {
  const staged = join(binDir(), 'better_sqlite3.node');
  try {
    return existsSync(staged)
      ? new Database(dbFile, { readonly: true, fileMustExist: true, nativeBinding: staged })
      : new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch {
    // Staged binding may be ABI-stale/absent — try default resolution once (dev/test).
    try {
      return new Database(dbFile, { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }
  }
}

/**
 * Classify the existing DB BEFORE phase-6's native open (and BEFORE staging
 * rewrites `.binding-info.json`, so the marker read reflects the PRIOR install).
 *
 *   - `fresh`            — no DB file; normal fresh install.
 *   - `already-migrated` — native marker present AND journal_mode is 'wal'.
 *   - `needs-migration`  — DB exists but delete-mode OR marker absent (wasm-era,
 *                          or embedded-but-never-WAL). Branches on journal_mode
 *                          independently of coverage, so a coverage-1 delete-mode
 *                          DB still gets the flip.
 */
export function classifyUpgrade(): UpgradeClassification {
  const dbFile = dbPath();
  if (!existsSync(dbFile)) {
    return { state: 'fresh', journalMode: null, markerPresent: false, coverage: 1 };
  }

  const markerPresent = existsSync(join(binDir(), '.binding-info.json'));
  let journalMode: string | null = null;
  let coverage = 1;

  const raw = openReadonly(dbFile);
  if (raw) {
    try {
      journalMode = String(raw.pragma('journal_mode', { simple: true }));
    } catch {
      journalMode = null;
    }
    try {
      const row = raw
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN embed_version = ? THEN 1 ELSE 0 END), 0) AS current
           FROM message_vectors`,
        )
        .get(EMBED_VERSION) as { total: number; current: number } | undefined;
      const total = row ? Number(row.total) : 0;
      const current = row ? Number(row.current ?? 0) : 0;
      coverage = total === 0 ? 1 : current / total;
    } catch {
      // No message_vectors / no embed_version column (very old DB) → assume 1.
      coverage = 1;
    }
    try {
      raw.close();
    } catch {
      /* ignore */
    }
  }

  const state: UpgradeState = markerPresent && journalMode === 'wal' ? 'already-migrated' : 'needs-migration';
  return { state, journalMode, markerPresent, coverage };
}

// ---------------------------------------------------------------------------
// Snapshot (rollback artifact, BEFORE the flip)
// ---------------------------------------------------------------------------

/**
 * Copy the (quiesced, delete-mode) DB to `${dbPath}.pre-upgrade-<stamp>` as a
 * rollback artifact. Derived from dbPath() so under a test's RECALL_HOME it
 * stays inside the temp root and never escapes to the live tree. Best-effort —
 * returns the snapshot path, or null if there's nothing to copy / the copy failed.
 */
export function snapshotDb(): string | null {
  const dbFile = dbPath();
  if (!existsSync(dbFile)) return null;
  const dest = `${dbFile}.pre-upgrade-${backupStamp()}`;
  try {
    copyFileSync(dbFile, dest);
    // A crashed delete-mode writer may have left a hot rollback journal — copy it
    // too so the snapshot stays self-consistent.
    const journal = `${dbFile}-journal`;
    if (existsSync(journal)) copyFileSync(journal, `${dest}-journal`);
    return dest;
  } catch (e) {
    log({ source: 'installer/upgrade', level: 'warn', summary: `pre-upgrade snapshot failed: ${(e as Error).message}` });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Integrity (AFTER the flip)
// ---------------------------------------------------------------------------

export type IntegrityStatus = 'ok' | 'repaired-stem' | 'unrecoverable';

export interface IntegrityOutcome {
  status: IntegrityStatus;
  /** The failing integrity_check detail (only when status is 'unrecoverable'). */
  detail?: string;
}

/** Run PRAGMA integrity_check on the open singleton. Wrapped: a malformed FTS
 *  vtable makes integrity_check itself throw ("vtable constructor failed"). */
function integrityStatus(): { ok: boolean; detail: string } {
  try {
    // allowPendingMigration: this runs from the installer, possibly BEFORE the
    // retrieval-class migration (phase 6.5 precedes 6.7) — the fail-closed
    // gate must not block the integrity check that gates the migration itself.
    const d = getDb(dbPath(), { allowPendingMigration: true });
    const row = d.get('PRAGMA integrity_check') as Record<string, unknown> | undefined;
    const detail = row ? String(Object.values(row)[0] ?? '') : 'unknown';
    return { ok: detail === 'ok', detail };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Drop + recreate the derived `_stem`/`_stem_vocab` FTS helpers (legacy wasm
 * corruption). They hold no user data — they're rebuilt lazily by the query
 * layer — so dropping them is always safe. `_stem_vocab` is an fts5vocab over
 * `_stem`; drop the referencer first. Recreation is delegated to ensureSchema
 * via a singleton reopen (`CREATE VIRTUAL TABLE IF NOT EXISTS`), so the DDL
 * stays single-sourced in db.ts. Returns true iff integrity is clean afterward.
 */
function repairStemTables(): boolean {
  try {
    const d = getDb(dbPath(), { allowPendingMigration: true });
    d.exec('DROP TABLE IF EXISTS _stem_vocab');
    d.exec('DROP TABLE IF EXISTS _stem');
    // Reopen so ensureSchema recreates _stem / _stem_vocab from scratch (a
    // pending-migration DB skips ensureSchema; its _stem is rebuilt by the
    // retrieval migration's shared DDL / next normal open). Kept inside the
    // try: some corruptions let the DROP succeed but leave orphan shadow
    // tables so the CREATE (on reopen) throws — that must surface as an
    // 'unrecoverable' (false), never an uncaught throw out of handleIntegrity.
    _resetDb();
    getDb(dbPath(), { allowPendingMigration: true });
    return integrityStatus().ok;
  } catch {
    return false;
  }
}

/**
 * Post-flip integrity gate. On a clean DB → 'ok'. On a `_stem`-scoped
 * malformation → drop + recreate and re-verify → 'repaired-stem'. On corruption
 * of real data (or an un-droppable `_stem`) → 'unrecoverable' (caller aborts
 * cleanly with a JSONL-rebuild advisory and preserves the snapshot). Never throws.
 */
export function handleIntegrity(): IntegrityOutcome {
  const st = integrityStatus();
  if (st.ok) return { status: 'ok' };
  // Only the derived _stem helper is safe to auto-drop. If integrity names _stem,
  // attempt the rebuild; anything else means real-data corruption.
  if (/_stem/i.test(st.detail) && repairStemTables()) {
    return { status: 'repaired-stem' };
  }
  return { status: 'unrecoverable', detail: st.detail };
}

// ---------------------------------------------------------------------------
// Drain gating + reporting
// ---------------------------------------------------------------------------

/** True iff run/backfill.pid records a still-live process. */
export function backfillAlreadyRunning(): boolean {
  const pidFile = join(runDir(), 'backfill.pid');
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (Number.isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The install-report / status line for an in-progress re-embed. Null when the
 *  table is fully at EMBED_VERSION (nothing to advertise). */
export function migrationReportLine(coverage: number): string | null {
  if (coverage >= 1) return null;
  const pct = Math.round(coverage * 100);
  return `Embed migration: re-embedding in background (${pct}% at v${EMBED_VERSION}) — semantic search stays available`;
}
