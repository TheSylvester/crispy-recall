/**
 * Purge Meta — historical cleanup for the ingest meta filter
 *
 * `recall backfill --purge-meta` deletes already-indexed machine boilerplate
 * rows that predate the ingest-time shouldDropAsMeta filter. The doomed set
 * is RECOMPUTED from the source transcripts with the exact predicate ingest
 * now applies (imported, never forked), then deleted as targeted rows —
 * kept rows' vectors are untouched, so there is zero re-embedding.
 *
 * Sessions are walked via session_provenance.transcript_path. A session
 * whose transcript file is gone is skipped and counted — its rows are
 * acceptable residue, never pattern-deleted here. Deletes run in one
 * transaction per session (resumable, bounded WAL growth); a re-run finds
 * nothing to delete for already-clean sessions.
 *
 * --dry-run performs the same walk on a read-only connection and writes
 * nothing.
 *
 * @module recall/purge-meta
 */

import { existsSync } from 'node:fs';
import { getDb, openReadonlyDb, type RecallDb } from '../db.js';
import { dbPath } from '../paths.js';
import { log } from '../log.js';
import { shouldDropAsMeta, META_KEEP_PREFIXES } from './transcript-utils.js';
import { firstTextContent } from '../adapters/system-context.js';
import { loadTranscriptEntries } from './message-ingest.js';

// ============================================================================
// Types
// ============================================================================

export interface PurgeMetaSummary {
  dryRun: boolean;
  /** Sessions whose transcript was re-read and re-classified. */
  sessionsScanned: number;
  /** Provenance rows whose transcript file no longer exists on disk. */
  sessionsSkippedMissing: number;
  /** Provenance rows with a NULL/empty transcript_path (cannot be re-read). */
  sessionsSkippedNoPath: number;
  /** Sessions whose transcript failed to parse (skipped, counted). */
  sessionsFailedParse: number;
  rowsDeleted: number;
  vectorRowsDeleted: number;
  bytesDeleted: number;
  /** Doomed entries whose first text starts with a META_KEEP_PREFIXES prefix.
   *  Must be 0 — the predicate whitelists them; non-zero means it is broken. */
  whitelistedDoomed: number;
  /** Doomed-row counts classified by first-text prefix. */
  buckets: Record<string, number>;
}

export interface PurgeMetaOptions {
  dryRun?: boolean;
  /** Override the DB file (tests). Defaults to the live dbPath(). */
  dbFile?: string;
}

// ============================================================================
// Doctor probe — cheap prefix-anchored residue count
// ============================================================================

/** Residual-boilerplate count over `messages`. Prefix-anchored LIKEs only —
 *  a full scan is seconds; mid-string patterns would not be. Whitelisted
 *  prefixes (<task-notification>, [SYSTEM NOTIFICATION) are excluded by
 *  design: those rows stay. */
export const META_RESIDUE_SQL = `
  SELECT COUNT(*) AS n FROM messages
  WHERE message_text LIKE '<command-name>%'
     OR message_text LIKE '<local-command-stdout>%'
     OR message_text LIKE '<local-command-caveat>%'
     OR message_text LIKE 'Base directory for this skill:%'
     OR message_text LIKE '# AGENTS.md instructions for%'
     OR message_text LIKE '<INSTRUCTIONS>%'
     OR message_text LIKE '<environment_context>%'`;

/** Run the residue probe on a RecallDb connection. */
export function countMetaResidue(d: RecallDb): number {
  const row = d.get(META_RESIDUE_SQL) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

// ============================================================================
// Bucket classification (reporting only — never part of the delete predicate)
// ============================================================================

const BUCKET_PREFIXES: Array<[bucket: string, prefix: string]> = [
  ['skill-injection', 'Base directory for this skill:'],
  ['command-echo', '<command-name>'],
  ['stdout', '<local-command-stdout>'],
  ['caveat', '<local-command-caveat>'],
  ['codex-preamble', '# AGENTS.md instructions for'],
  ['codex-preamble', '<INSTRUCTIONS>'],
  ['codex-preamble', '<environment_context>'],
];

function bucketOf(text: string | undefined): string {
  if (text) {
    for (const [bucket, prefix] of BUCKET_PREFIXES) {
      if (text.startsWith(prefix)) return bucket;
    }
  }
  return 'other';
}

// ============================================================================
// Purge pass
// ============================================================================

/** SQLite's classic safe bound is 999 host parameters per statement; chunk
 *  IN-lists at 900 to leave room for the session_id bind. */
const CHUNK_SIZE = 900;

const PROGRESS_EVERY = 500;

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Run the purge (or dry-run) over every provenance-tracked session.
 *
 * Dry-run opens its OWN read-only connection and closes it; the real run
 * uses the shared singleton (the CLI closes it on exit).
 */
export async function runPurgeMeta(opts: PurgeMetaOptions = {}): Promise<PurgeMetaSummary> {
  const dryRun = opts.dryRun === true;
  const file = opts.dbFile ?? dbPath();
  const d = dryRun ? openReadonlyDb(file) : getDb(file);
  try {
    return purgeWalk(d, dryRun);
  } finally {
    if (dryRun) d.close();
  }
}

function purgeWalk(d: RecallDb, dryRun: boolean): PurgeMetaSummary {
  const summary: PurgeMetaSummary = {
    dryRun,
    sessionsScanned: 0,
    sessionsSkippedMissing: 0,
    sessionsSkippedNoPath: 0,
    sessionsFailedParse: 0,
    rowsDeleted: 0,
    vectorRowsDeleted: 0,
    bytesDeleted: 0,
    whitelistedDoomed: 0,
    buckets: {},
  };

  const provRows = d.all(
    `SELECT session_id, vendor, transcript_path FROM session_provenance ORDER BY session_id`,
  ) as Array<{ session_id: string; vendor: string; transcript_path: string | null }>;

  let processed = 0;
  for (const prov of provRows) {
    processed++;
    if (processed % PROGRESS_EVERY === 0) {
      log({
        source: 'recall:purge-meta',
        level: 'info',
        summary: `${processed}/${provRows.length} sessions walked — ${summary.rowsDeleted} rows ${dryRun ? 'would be ' : ''}deleted`,
      });
    }

    if (!prov.transcript_path) {
      summary.sessionsSkippedNoPath++;
      continue;
    }
    if (prov.vendor !== 'claude' && prov.vendor !== 'codex') {
      summary.sessionsFailedParse++;
      continue;
    }
    if (!existsSync(prov.transcript_path)) {
      summary.sessionsSkippedMissing++;
      continue;
    }

    let entries;
    try {
      entries = loadTranscriptEntries(prov.transcript_path, prov.vendor, prov.session_id);
    } catch (err) {
      summary.sessionsFailedParse++;
      log({
        source: 'recall:purge-meta',
        level: 'warn',
        summary: `failed to parse ${prov.transcript_path}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    summary.sessionsScanned++;

    // Recompute the doomed set with THE ingest predicate. Dedupe uuids —
    // adapters can emit the same uuid twice across appended envelopes.
    const doomed = new Set<string>();
    const bucketById = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.uuid || doomed.has(entry.uuid)) continue;
      if (!shouldDropAsMeta(entry)) continue;
      const text = firstTextContent(entry.message);
      if (text && META_KEEP_PREFIXES.some((p) => text.startsWith(p))) {
        // Predicate tripwire: shouldDropAsMeta must never doom a whitelisted
        // entry. Count it (the live gate requires 0) and do NOT delete it.
        summary.whitelistedDoomed++;
        continue;
      }
      doomed.add(entry.uuid);
      bucketById.set(entry.uuid, bucketOf(text));
    }
    if (doomed.size === 0) continue;

    // Which doomed uuids actually exist as rows of THIS session?
    const found: Array<{ message_id: string; bytes: number; has_vector: number }> = [];
    for (const chunk of chunks([...doomed], CHUNK_SIZE)) {
      const ph = chunk.map(() => '?').join(',');
      found.push(
        ...(d.all(
          `SELECT m.message_id,
                  length(CAST(m.message_text AS BLOB)) AS bytes,
                  EXISTS(SELECT 1 FROM message_vectors mv WHERE mv.message_id = m.message_id) AS has_vector
           FROM messages m
           WHERE m.session_id = ? AND m.message_id IN (${ph})`,
          [prov.session_id, ...chunk],
        ) as Array<{ message_id: string; bytes: number; has_vector: number }>),
      );
    }
    if (found.length === 0) continue;

    if (!dryRun) {
      // One transaction per session: vectors first (no trigger covers them),
      // then messages (the hot-gated FTS delete trigger fires automatically).
      d.exec('BEGIN IMMEDIATE');
      try {
        for (const chunk of chunks(found.map((f) => f.message_id), CHUNK_SIZE)) {
          const ph = chunk.map(() => '?').join(',');
          d.run(`DELETE FROM message_vectors WHERE message_id IN (${ph})`, chunk);
          d.run(
            `DELETE FROM messages WHERE session_id = ? AND message_id IN (${ph})`,
            [prov.session_id, ...chunk],
          );
        }
        d.exec('COMMIT');
      } catch (e) {
        try { d.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    }

    summary.rowsDeleted += found.length;
    for (const f of found) {
      summary.bytesDeleted += Number(f.bytes);
      if (f.has_vector) summary.vectorRowsDeleted++;
      const bucket = bucketById.get(f.message_id) ?? 'other';
      summary.buckets[bucket] = (summary.buckets[bucket] ?? 0) + 1;
    }
  }

  return summary;
}

/** Human-readable summary block for the CLI. */
export function formatPurgeMetaSummary(s: PurgeMetaSummary): string {
  const verb = s.dryRun ? 'would delete' : 'deleted';
  const buckets = Object.entries(s.buckets)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || 'none';
  return [
    `purge-meta${s.dryRun ? ' (dry-run — read-only, nothing written)' : ''}`,
    `  sessions scanned:        ${s.sessionsScanned}`,
    `  skipped (file missing):  ${s.sessionsSkippedMissing}`,
    `  skipped (no path):       ${s.sessionsSkippedNoPath}`,
    `  skipped (parse failed):  ${s.sessionsFailedParse}`,
    `  rows ${verb}:       ${s.rowsDeleted}`,
    `  vector rows ${verb}: ${s.vectorRowsDeleted}`,
    `  text bytes ${verb}:  ${s.bytesDeleted}`,
    `  whitelistedDoomed:       ${s.whitelistedDoomed}${s.whitelistedDoomed > 0 ? '  ← MUST BE 0, predicate broken' : ''}`,
    `  buckets:                 ${buckets}`,
  ].join('\n');
}
