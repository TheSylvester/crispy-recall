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
import { getDb, closeDbBeforeChildSpawn, RETRIEVAL_SCHEMA_DDL, PROJECT_KEY_BACKFILL_KEY, LEGACY_CODEX_ID_SQL } from '../db.js';
import { dbPath, binDir, remoteRoot } from '../paths.js';
import { mirrorRoots } from '../hub/mirror.js';
import { log } from '../log.js';
import { deriveProjectKey, upgradeLocalPathKey, wslUncToPosix } from '../recall/project-key.js';
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
      // Close before the child attaches: it may reset the wal-index and
      // SIGBUS this process's stale `-shm` map (db.ts closeDbBeforeChildSpawn).
      closeDbBeforeChildSpawn();
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

export interface RepairFullResult {
  /** True when the run was refused (mirror root present but unenumerable) — nothing was touched. */
  refused: boolean;
  /** Mirror hosts whose transcripts were re-ingested beside the home roots. */
  mirrorHosts: string[];
}

/**
 * Destructive full reingest: delete all messages (+ cascades to vectors/FTS)
 * and the ingest_watermark, then reingest every transcript from JSONL.
 * Auto-confirms under `--yes` or when stdin is not a TTY (scriptable/testable).
 */
export async function repairFull(opts: RepairFullOptions = {}): Promise<RepairFullResult> {
  // Spec §2.5: the mirror is part of what a full repair re-ingests. Name the
  // hosts BEFORE deleting, and refuse when `remoteRoot()` exists but holds no
  // enumerable vendor root — a wipe now could never be re-ingested.
  const roots = mirrorRoots();
  const hosts = [...new Set(roots.map((r) => r.root.split('/').slice(-2)[0]!))].sort();
  if (existsSync(remoteRoot()) && roots.length === 0) {
    console.error(
      `recall repair --full: ${remoteRoot()} exists but enumerates no mirror roots ` +
      '(<host>/claude or <host>/codex) — refusing to delete the index. ' +
      'Restore the mirror or remove the empty directory first.',
    );
    return { refused: true, mirrorHosts: [] };
  }
  console.log(hosts.length
    ? `repair --full: mirror hosts to re-ingest: ${hosts.join(', ')}`
    : 'repair --full: no mirror hosts (home roots only)');

  const auto = opts.yes || !process.stdin.isTTY;
  if (!auto) {
    const go = await confirm({
      message: 'This will delete all indexed messages and reingest every transcript from JSONL — confirm?',
      initialValue: false,
    });
    if (isCancel(go) || !go) {
      log({ source: 'installer/repair', level: 'info', summary: 'repair --full cancelled' });
      return { refused: false, mirrorHosts: hosts };
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
  // Mirror watermarks: listAllSessions (inside the catch-up) already ingested
  // the mirror files; this pass records their (mtime, size) so the hub sweep
  // sees them as unchanged. It is the hub's own sweep, so the cross-host
  // collision guard (S11) applies here too. Sidecars are never touched.
  if (roots.length > 0) {
    const { runMirrorSweep } = await import('../hub/sweep.js');
    await runMirrorSweep();
  }
  log({ source: 'installer/repair', level: 'info', summary: 'full repair reingest complete' });
  return { refused: false, mirrorHosts: hosts };
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
  /** Rows carrying a `\\wsl$\…` UNC key that this pass rewrote. */
  wslRows: number;
  /** Of those, rows that reached a `git:`/`origin:` key. */
  wslUpgraded: number;
  /** Of those, rows the hub could not verify — the UNC key is KEPT for a retry. */
  wslRetryable: number;
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
  /** UNC project_ids the hub could not resolve — left for a later run. */
  const wslRetryableIds: string[] = [];
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

    // A `\\wsl$\…` project_id must NEVER be keyed by a bare `path:<posix>`:
    // that path is the one the hub could not verify, and such a key would
    // fall out of the UNC branch below AND out of every later run. Only a
    // reached repository identity is written; anything else stays as it is.
    const unc = wslUncToPosix(projectId);
    if (unc) {
      const upgraded = upgradeLocalPathKey('path:' + unc.posix);
      if (upgraded.startsWith('git:') || upgraded.startsWith('origin:')) {
        derived.push({ projectId, key: upgraded });
      } else {
        wslRetryableIds.push(projectId);
      }
      continue;
    }

    const result = deriveProjectKey(projectId);
    if (result.transientFailure || !result.key) { transient++; continue; }
    derived.push({ projectId, key: result.key });
  }

  // WSL UNC keys (U3). A Windows satellite that works on a repository inside
  // WSL saw a `\\wsl$\<distro>\…` cwd and keyed the mount, not the repository,
  // so the one repository split into two keys. Such a key is provably wrong,
  // and this branch corrects it without `--force`.
  const wslKeys = (d.all(
    `SELECT DISTINCT project_key AS key FROM messages
      WHERE project_key LIKE 'path://wsl$/%' OR project_key LIKE 'path://wsl.localhost/%'`,
  ) as Array<{ key: string }>);
  const wslRewrites: Array<{ from: string; to: string }> = [];
  const wslRetryableKeys: string[] = [];
  for (const row of wslKeys) {
    const to = upgradeLocalPathKey(row.key);
    // ONLY a reached repository identity earns an UPDATE. A path the hub
    // could not verify — a case the old win32 fold destroyed, a directory
    // that is temporarily absent, a transient git — must keep its UNC key:
    // rewriting it to a bare `path:<posix>` would drop it out of this branch
    // and out of the main pass, and no later run could ever correct it.
    if (to.startsWith('git:') || to.startsWith('origin:')) wslRewrites.push({ from: row.key, to });
    else wslRetryableKeys.push(row.key);
  }

  let updated = 0;
  let wslRows = 0;
  let wslUpgraded = 0;
  let wslRetryable = 0;

  // A UNC project_id the hub could not resolve leaves its NULL-keyed rows
  // NULL, exactly as a transient derivation does, so it blocks the marker the
  // same way: the backfill is not complete until a later run resolves it.
  const wslNullRows = wslRetryableIds.reduce((acc, projectId) => {
    const row = d.get(
      `SELECT COUNT(*) AS c FROM messages WHERE project_id = ? AND project_key IS NULL`,
      [projectId],
    ) as { c?: number } | undefined;
    return acc + Number(row?.c ?? 0);
  }, 0);
  const markerWritten = transient === 0 && wslNullRows === 0;

  d.exec('BEGIN IMMEDIATE');
  try {
    d.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    d.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
    d.exec('DROP TRIGGER IF EXISTS messages_fts_au');

    // `--force` re-keys an already-keyed row, but never a UNC key: that key
    // is the ONLY handle the rewrite below has on the row, and a derivation
    // from a UNC project_id cannot beat what the rewrite computes.
    const sql = opts.force
      ? `UPDATE messages SET project_key = ? WHERE project_id = ?
           AND (project_key IS NULL
                OR (project_key NOT LIKE 'path://wsl$/%'
                    AND project_key NOT LIKE 'path://wsl.localhost/%'))`
      : `UPDATE messages SET project_key = ? WHERE project_id = ? AND project_key IS NULL`;
    for (const row of derived) {
      const info = d.run(sql, [row.key, row.projectId]) as { changes?: number } | undefined;
      updated += Number(info?.changes ?? 0);
    }

    // The UNC rewrite runs after the main pass, which leaves UNC keys alone
    // under `--force` too, so the two never fight over the same row.
    for (const row of wslRewrites) {
      const info = d.run(
        `UPDATE messages SET project_key = ? WHERE project_key = ?`, [row.to, row.from],
      ) as { changes?: number } | undefined;
      const n = Number(info?.changes ?? 0);
      wslRows += n;
      wslUpgraded += n;
    }
    for (const key of wslRetryableKeys) {
      const row = d.get(
        `SELECT COUNT(*) AS c FROM messages WHERE project_key = ?`, [key],
      ) as { c?: number } | undefined;
      const n = Number(row?.c ?? 0);
      wslRows += n;
      wslRetryable += n;
    }
    // The rows a UNC project_id left behind. Rows that ALSO carry a UNC key
    // are excluded — the loop above already counted those.
    for (const projectId of wslRetryableIds) {
      const row = d.get(
        `SELECT COUNT(*) AS c FROM messages WHERE project_id = ?
           AND (project_key IS NULL
                OR (project_key NOT LIKE 'path://wsl$/%'
                    AND project_key NOT LIKE 'path://wsl.localhost/%'))`,
        [projectId],
      ) as { c?: number } | undefined;
      const n = Number(row?.c ?? 0);
      wslRows += n;
      wslRetryable += n;
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
      `${skippedMirror} mirror-only skipped, ${transient} transient (left NULL); ` +
      `wsl-unc keys: ${wslRows} rows → ${wslUpgraded} upgraded, ${wslRetryable} left (retryable)`,
  });

  return {
    projectIds: considered, updated, skippedMirror, transient,
    wslRows, wslUpgraded, wslRetryable, markerWritten,
  };
}
