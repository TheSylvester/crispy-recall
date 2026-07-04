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
import { getDb } from '../db.js';
import { dbPath } from '../paths.js';
import { log } from '../log.js';

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
    d.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');");
  } catch (e) {
    ftsOk = false;
    ftsError = (e as Error).message;
  }

  return { mainOk, mainDetail, ftsOk, ...(ftsError ? { ftsError } : {}) };
}

/** Rebuild the messages_fts index from the messages table. Idempotent. */
export function repairFts(): void {
  db().exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  log({ source: 'installer/repair', level: 'info', summary: 'messages_fts rebuilt' });
}

/** Drop all embeddings; the next embed-pending sweep rebuilds them. */
export function repairVectors(): void {
  db().exec('DELETE FROM message_vectors;');
  log({ source: 'installer/repair', level: 'info', summary: 'message_vectors cleared — will re-embed on next sweep' });
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
