/**
 * repair — FTS5 / vector / full-rebuild recovery.
 *
 * Repair is a CONSUMER of the persisted embedder config (~/.recall/config.json):
 * `--full`'s re-embed pass honors the recorded GPU/CPU choice and never re-runs
 * GPU detection. All operations open the DB with `PRAGMA foreign_keys = ON` so
 * `ON DELETE CASCADE` (message_vectors) and the messages_fts delete trigger fire
 * on `DELETE FROM messages`.
 *
 * @module installer/repair
 */

import { confirm, isCancel } from '@clack/prompts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, RETRIEVAL_SCHEMA_DDL, PROJECT_KEY_BACKFILL_KEY, LEGACY_CODEX_ID_SQL } from '../db.js';
import { dbPath, binDir } from '../paths.js';
import { log } from '../log.js';
import { deriveProjectKey } from '../recall/project-key.js';
import { isUnderRemoteRoot } from '../recall/mirror-meta.js';
import type { CodexRekeyResult } from './codex-rekey-migration.js';

function db() {
  const d = getDb(dbPath());
  d.exec('PRAGMA foreign_keys = ON');
  return d;
}

export interface IntegrityResult {
  mainOk: boolean;
  mainDetail: string;
  ftsOk: boolean;
  ftsError?: string;
}

/** Run PRAGMA integrity_check (main DB) AND the FTS5 self-check. */
export function integrityCheck(): IntegrityResult {
  const d = db();
  const row = d.get('PRAGMA integrity_check') as Record<string, unknown> | undefined;
  const mainDetail = row ? String(Object.values(row)[0] ?? '') : 'unknown';
  const mainOk = mainDetail === 'ok';

  let ftsOk = true;
  let ftsError: string | undefined;
  try {
    // RANK-1 form, always: for an external-content FTS5 table the rank-less
    // 'integrity-check' does NOT compare the index against its content source,
    // so a filtered-view/index mismatch passes silently. rank=1 forces the
    // comparison (empirically verified in test/unit/fts-filtered-view.test.ts).
    d.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1);");
  } catch (e) {
    ftsOk = false;
    ftsError = (e as Error).message;
  }

  return { mainOk, mainDetail, ftsOk, ...(ftsError ? { ftsError } : {}) };
}

/** Rebuild the messages_fts index. Idempotent. Reads the FILTERED
 *  searchable_messages view, so a rebuild can never resurrect agent-leaf
 *  content into default retrieval. */
export function repairFts(): void {
  db().exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  log({ source: 'installer/repair', level: 'info', summary: 'messages_fts rebuilt (hot rows only — filtered view)' });
}

/** Drop all embeddings; the next embed-pending sweep rebuilds them. */
export function repairVectors(): void {
  db().exec('DELETE FROM message_vectors;');
  log({ source: 'installer/repair', level: 'info', summary: 'message_vectors cleared — will re-embed on next sweep' });
}

/**
 * `recall repair --rekey-codex` — attended entry point for the
 * `codex_message_id_v2` migration (spec §5).
 *
 * Attended means attended: on a TTY without `--yes` it names the blast radius
 * and asks first. The force re-ingests drop the re-keyed sessions' vectors, so
 * a performed run MUST be followed by a drain — a detached `embed-pending.js`
 * when one is staged, else a printed instruction to run
 * `recall backfill --auto-embed`.
 */
export async function repairRekeyCodex(
  opts: { yes?: boolean } = {},
): Promise<CodexRekeyResult | null> {
  if (!opts.yes && process.stdout.isTTY) {
    const pending = countPendingCodexSessions();
    const go = await confirm({
      message:
        `Re-key ${pending} Codex session(s) to full-uuid message ids? ` +
        'Each is re-ingested from its transcript, which DROPS its embedding vectors; ' +
        'they re-embed in a background drain afterwards.',
      initialValue: false,
    });
    if (isCancel(go) || !go) {
      console.error('recall repair --rekey-codex: cancelled — nothing was changed.');
      return null;
    }
  }

  const { runCodexRekeyMigration } = await import('./codex-rekey-migration.js');
  const result = await runCodexRekeyMigration();

  // Drain on ANY performed run that left work: the vectors a reclassified
  // session dropped are just as absent as the ones a re-keyed session dropped.
  const { getEmbeddingGapStats } = await import('../recall/message-store.js');
  if (result.performed && (result.vectorsDropped > 0 || getEmbeddingGapStats().gapCount > 0)) {
    const child = join(binDir(), 'embed-pending.js');
    if (existsSync(child)) {
      spawn(process.execPath, [child], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      log({ source: 'installer/repair', level: 'info', summary: 'codex re-key: detached embed-pending drain launched' });
    } else {
      console.log('run: recall backfill --auto-embed to re-embed the dropped vectors');
    }
  }
  return result;
}

/** Sessions still holding legacy Codex ids — the confirm prompt's blast radius. */
function countPendingCodexSessions(): number {
  try {
    // The codex gate is still shut here, so open through the attended door.
    const row = getDb(dbPath(), { allowPendingMigration: true }).get(
      `SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`,
    ) as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  } catch {
    return 0;
  }
}

export interface RepairFullOptions { yes?: boolean }

/**
 * Destructive full reingest: delete all messages (+ cascades to vectors/FTS)
 * and the ingest_watermark, then reingest every transcript from JSONL.
 * Auto-confirms under `--yes` or when stdin is not a TTY (scriptable/testable).
 */
export async function repairFull(opts: RepairFullOptions = {}): Promise<void> {
  const auto = opts.yes || !process.stdin.isTTY;
  if (!auto) {
    const go = await confirm({
      message: 'This will delete all indexed messages and reingest every transcript from JSONL — confirm?',
      initialValue: false,
    });
    if (isCancel(go) || !go) {
      log({ source: 'installer/repair', level: 'info', summary: 'repair --full cancelled' });
      return;
    }
  }

  const d = db();
  // BEGIN IMMEDIATE: acquire the write lock up front so a concurrent writer
  // (a Stop hook mid-repair) waits on busy_timeout instead of hitting a
  // deferred-transaction SQLITE_BUSY_SNAPSHOT under WAL.
  d.exec('BEGIN IMMEDIATE');
  try {
    // DELETE FROM messages cascades to message_vectors (FK) + messages_fts (trigger).
    d.exec('DELETE FROM messages;');
    // REQUIRED: otherwise steady-state catch-up sees "no change" and reingests nothing.
    d.exec('DELETE FROM ingest_watermark;');
    // Provenance/aliases are rebuilt by the reingest's classifier — stale rows
    // would otherwise pin old classifications onto freshly reingested sessions.
    d.exec('DELETE FROM session_provenance;');
    d.exec('DELETE FROM session_aliases;');
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  log({ source: 'installer/repair', level: 'info', summary: 'messages + ingest_watermark cleared — reingesting' });

  // Reingest. The embed pass reuses the persisted embedder config (config.ts);
  // repair does NOT re-detect or re-test the GPU.
  const { startRecallCatchup } = await import('../recall/catchup.js');
  const { mtimeScan } = await import('../recall/mtime-scan.js');
  await startRecallCatchup({ autoEmbed: true });
  await mtimeScan();
  log({ source: 'installer/repair', level: 'info', summary: 'full repair reingest complete' });
}

// ---------------------------------------------------------------------------
// repair --rekey-projects — fill messages.project_key for existing rows
// ---------------------------------------------------------------------------

export interface RekeyProjectsResult {
  /** Distinct local project_ids considered (mirror-only ones excluded). */
  projectIds: number;
  /** Rows the UPDATEs touched. */
  updated: number;
  /** project_ids whose every session is mirrored — their sidecar keys stand. */
  skippedMirror: number;
  /** project_ids whose derivation failed transiently — rows left NULL. */
  transient: number;
  /** Whether the durable 'complete' marker was written (false → re-run). */
  markerWritten: boolean;
}

/**
 * Attended backfill of `messages.project_key` (spec §4.3). Hub only.
 *
 * Mirror-only project_ids are skipped: those rows carry the key their
 * satellite derived, shipped in the push sidecar, and this machine has no
 * such directory to derive from. A vanished local directory still yields a
 * `path:` key, which is exactly what it scoped by before.
 *
 * The three FTS triggers are dropped for the mass UPDATE and recreated from
 * the shared DDL inside the SAME transaction: `messages_fts_au` is unscoped
 * and would re-tokenize every hot row it touches (verified 1146 → 2029 FTS
 * segments on 100K rows).
 */
export function repairRekeyProjects(opts: { force: boolean }): RekeyProjectsResult {
  const d = db();

  const projectIds = (d.all(
    `SELECT DISTINCT project_id FROM messages WHERE project_id IS NOT NULL`,
  ) as Array<{ project_id: string }>).map((r) => r.project_id);

  const derived: Array<{ projectId: string; key: string }> = [];
  let considered = 0;
  let skippedMirror = 0;
  let transient = 0;

  for (const projectId of projectIds) {
    // MIRROR-ONLY = every session carrying this project_id has a provenance
    // transcript_path under remoteRoot(). A session with no provenance row
    // counts as local (its transcript may still be on this disk).
    const paths = d.all(
      `SELECT DISTINCT p.transcript_path AS path
       FROM messages m
       LEFT JOIN session_provenance p ON p.session_id = m.session_id
       WHERE m.project_id = ?`,
      [projectId],
    ) as Array<{ path: string | null }>;
    const allMirrored = paths.length > 0
      && paths.every((r) => typeof r.path === 'string' && isUnderRemoteRoot(r.path));
    if (allMirrored) { skippedMirror++; continue; }
    considered++;

    const result = deriveProjectKey(projectId);
    if (result.transientFailure || !result.key) { transient++; continue; }
    derived.push({ projectId, key: result.key });
  }

  let updated = 0;
  const markerWritten = transient === 0;

  d.exec('BEGIN IMMEDIATE');
  try {
    d.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    d.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
    d.exec('DROP TRIGGER IF EXISTS messages_fts_au');

    const sql = opts.force
      ? `UPDATE messages SET project_key = ? WHERE project_id = ?`
      : `UPDATE messages SET project_key = ? WHERE project_id = ? AND project_key IS NULL`;
    for (const row of derived) {
      const info = d.run(sql, [row.key, row.projectId]) as { changes?: number } | undefined;
      updated += Number(info?.changes ?? 0);
    }

    // Every statement in `fts` is IF NOT EXISTS, so the view, FTS table and
    // vocab survive untouched and only the three triggers come back.
    d.exec(RETRIEVAL_SCHEMA_DDL.fts);

    // Marker LAST, and only when nothing was left NULL by a transient failure.
    if (markerWritten) {
      d.run(
        `INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'complete')`,
        [PROJECT_KEY_BACKFILL_KEY],
      );
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }

  log({
    source: 'installer/repair',
    level: 'info',
    summary: `project keys: ${considered} project_ids, ${updated} rows updated, ` +
      `${skippedMirror} mirror-only skipped, ${transient} transient (left NULL)`,
  });

  return { projectIds: considered, updated, skippedMirror, transient, markerWritten };
}
