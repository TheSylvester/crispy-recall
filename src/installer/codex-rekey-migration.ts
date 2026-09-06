/**
 * codex-rekey-migration — the attended `codex_message_id_v2` migration (spec §5).
 *
 * Codex message ids used to be `codex-jsonl-<8 hex of session uuid>-<counter>`.
 * A UUIDv7 8-hex prefix is a ~65 s bucket, so sibling sessions shared ids and
 * `INSERT OR IGNORE` silently dropped their turns. The adapter now emits the
 * FULL uuid; this module rewrites the legacy rows.
 *
 * It takes a WAL-safe snapshot first, then re-ingests each affected session
 * with `force: true`, one session per transaction. A force re-ingest deletes
 * the session's vectors in the same transaction (message-store.ts:119-128), so
 * the run de-vectorizes every re-keyed session and prints `vectors dropped: N`
 * — the attended caller MUST follow with a drain (`embed-pending.js` /
 * `recall backfill --auto-embed`).
 *
 * A force re-ingest that would yield ZERO records also deletes the session's
 * rows, so every session is counted first (`countIndexableRecords`) and skipped
 * when the count is 0: a rotated, unreadable or now-all-boilerplate transcript
 * keeps its legacy rows instead of being purged.
 *
 * The marker is written LAST and always (even when some sessions could not be
 * re-ingested), because the gate exists to stop UNATTENDED rewrites, not to
 * block a hub whose oldest transcripts are gone.
 *
 * @module installer/codex-rekey-migration
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { glob } from 'glob';
import {
  getDb, isCodexRekeyPending, CODEX_REKEY_MIGRATION_KEY, LEGACY_CODEX_ID_SQL,
} from '../db.js';
import { dbPath, remoteRoot, transcriptGlob } from '../paths.js';
import { listCodexSessionFiles } from '../adapters/codex/codex-jsonl-reader.js';
import { ingestSessionMessages, countIndexableRecords } from '../recall/message-ingest.js';
import { log } from '../log.js';

/** The `schema_meta` key that says every Codex message_id carries a full uuid. */
export const CODEX_REKEY_KEY = CODEX_REKEY_MIGRATION_KEY;

/** Re-exported from the db leaf so `doctor` need not import this module. */
export { LEGACY_CODEX_ID_SQL };

/** `rollout-<ISO>-<uuid>.jsonl` → the uuid. */
const ROLLOUT_BASENAME_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexRekeyResult {
  /** False when the marker was already 'complete' (idempotent re-run). */
  performed: boolean;
  /** Distinct sessions holding legacy ids at the start of the run. */
  sessions: number;
  /** Sessions re-ingested under full-uuid ids. */
  reingested: number;
  /** Sessions whose transcript could not be found anywhere. */
  fileGone: number;
  /** Sessions whose transcript would yield ZERO rows — skipped, never purged. */
  emptied: number;
  /** Vectors deleted by the force re-ingests (the drain gap this opens). */
  vectorsDropped: number;
  /** Distinct sessions still holding legacy ids after the run. */
  legacyRemaining: number;
  /** WAL-safe pre-migration snapshot (null on an idempotent no-op re-run). */
  snapshotPath: string | null;
}


/**
 * Rewrite every legacy Codex message id to the full-uuid form, then write the
 * durable marker. Idempotent: a second run returns `performed: false`.
 *
 * The caller owns the connection lifecycle — this never calls `_resetDb`.
 */
export async function runCodexRekeyMigration(
  opts?: { log?: (line: string) => void },
): Promise<CodexRekeyResult> {
  const say = opts?.log ?? ((line: string) => console.log(line));

  const d = getDb(dbPath(), { allowPendingMigration: true });
  d.exec('PRAGMA busy_timeout = 30000');

  const result: CodexRekeyResult = {
    performed: false, sessions: 0, reingested: 0, fileGone: 0, emptied: 0,
    vectorsDropped: 0, legacyRemaining: 0, snapshotPath: null,
  };
  if (!isCodexRekeyPending(d)) return result;
  result.performed = true;

  // Enumerate from `messages`, NEVER from session_provenance: on the live hub
  // 1,102 of 2,978 affected sessions have no provenance row at all. Counted
  // BEFORE the snapshot: install.ts treats every 0.3.x DB as codexPending, so
  // snapshotting first made a Claude-only multi-gigabyte hub copy the whole
  // database to re-key zero rows.
  const sessions = (d.all(
    `SELECT DISTINCT session_id AS id FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`,
  ) as Array<{ id: string }>).map((r) => r.id);
  result.sessions = sessions.length;

  if (sessions.length === 0) {
    // Nothing to rewrite — open the gate with no rollback insurance to buy.
    d.run(
      `INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'complete')`,
      [CODEX_REKEY_KEY],
    );
    say('codex re-key: 0 sessions carry legacy ids — marker written, no snapshot taken');
    return result;
  }

  // Rollback insurance BEFORE the first rewrite — thousands of per-session
  // transactions are not one atomic unit. Probed only after the early returns,
  // so an idempotent re-run never copies a gigabyte. A failure propagates:
  // install.ts phase 6.8 restores the quiesced hooks and aborts.
  const { snapshotDbWalSafe } = await import('./retrieval-class-migration.js');
  result.snapshotPath = await snapshotDbWalSafe('codex-rekey');
  say(`codex-rekey: snapshot ${result.snapshotPath}`);

  // Hoisted resolution indexes: one watermark query and ONE walk of the Codex
  // tree for the whole run, not one of each per session.
  const watermarkBySid = new Map<string, string>();
  for (const row of d.all(
    `SELECT transcript_path AS p FROM ingest_watermark WHERE vendor = 'codex'`,
  ) as Array<{ p: string }>) {
    const m = ROLLOUT_BASENAME_RE.exec(basename(row.p));
    if (m && m[1] && !watermarkBySid.has(m[1])) watermarkBySid.set(m[1], row.p);
  }
  const localBySid = listCodexSessionFiles();

  for (const id of sessions) {
    const path = await resolveRollout(d, id, watermarkBySid, localBySid);
    if (!path) {
      result.fileGone++;
      say(`codex-rekey: transcript gone for ${id} — legacy ids kept`);
      continue;
    }

    // Pre-flight: a force ingest yielding zero records DELETES the session's
    // rows and vectors and reports no error. Never make that call.
    if (countIndexableRecords(path, 'codex', id) === 0) {
      result.emptied++;
      say(`codex-rekey: ${id} — ${path} yielded 0 indexable entries; legacy ids KEPT`);
      continue;
    }

    const before = (d.get(
      `SELECT COUNT(*) AS c FROM message_vectors WHERE message_id IN
       (SELECT message_id FROM messages WHERE session_id = ?)`,
      [id],
    ) as { c: number } | undefined)?.c ?? 0;

    // One session per call, each its own transaction: insertMessages opens
    // BEGIN IMMEDIATE itself, so an outer transaction would throw.
    const r = await ingestSessionMessages(id, path, 'codex', { force: true });
    if (r.error) {
      say(`codex-rekey: ingest failed for ${id} — ${r.error}`);
      continue;
    }
    // The force call RAN, so the vectors under the id it wrote are gone
    // whatever the outcome — the drain owes them regardless of the branch below.
    result.vectorsDropped += before;

    if (r.sessionId !== id) {
      // classifySession resolved a different canonical id (the bounded
      // session_meta read newly exposes a >8 KB meta), so the rows under the
      // enumerated id were NOT replaced.
      say(`codex-rekey: ${id} reclassified to ${r.sessionId}; legacy rows under ${id} kept`);
      continue;
    }
    if (r.chunksCreated === 0) {
      // Belt to the pre-flight's braces: the count said non-zero, the ingest
      // wrote nothing. Report it rather than claim a re-key.
      result.emptied++;
      say(`codex-rekey: ${id} re-ingested to 0 rows — NOT counted as re-keyed`);
      continue;
    }
    result.reingested++;
  }

  result.legacyRemaining = (d.get(
    `SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`,
  ) as { c: number } | undefined)?.c ?? 0;

  const expectedRemaining = result.fileGone + result.emptied;
  if (result.legacyRemaining !== expectedRemaining) {
    const summary =
      `codex-rekey: ${result.legacyRemaining} sessions still carry legacy ids but only ` +
      `${expectedRemaining} were skipped (${result.fileGone} gone, ${result.emptied} empty) ` +
      '— an ingest error or a reclassified session is the usual cause';
    say(`warn: ${summary}`);
    log({ source: 'installer/codex-rekey', level: 'warn', summary });
  }

  // Marker LAST — the gate reopens only once the rows above have been walked.
  d.run(
    `INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'complete')`,
    [CODEX_REKEY_KEY],
  );

  say(`vectors dropped: ${result.vectorsDropped}`);
  say(
    `codex re-key: ${result.sessions} sessions, ${result.reingested} re-ingested, ` +
    `${result.fileGone} transcripts gone, ${result.emptied} empty transcripts skipped, ` +
    `${result.vectorsDropped} vectors dropped, snapshot ${result.snapshotPath}`,
  );
  return result;
}

/**
 * Resolve the rollout file for a session id. First hit wins:
 * provenance → watermark → `~/.codex/sessions` → mirror.
 *
 * The watermark and local-tree indexes are built once per run; only the
 * mirror glob is per session, and only for a session nothing else resolved.
 */
async function resolveRollout(
  d: ReturnType<typeof getDb>,
  sessionId: string,
  watermarkBySid: Map<string, string>,
  localBySid: Map<string, string>,
): Promise<string | null> {
  // (a) recorded provenance path (PRIMARY KEY lookup — cheap per session)
  const prov = d.get(
    `SELECT transcript_path AS p FROM session_provenance WHERE session_id = ?`,
    [sessionId],
  ) as { p?: string } | undefined;
  if (prov?.p && existsSync(prov.p)) return prov.p;

  // (b) a codex watermark whose basename names this session
  const mark = watermarkBySid.get(sessionId);
  if (mark && existsSync(mark)) return mark;

  // (c) the local Codex sessions tree (honors CODEX_HOME)
  const local = localBySid.get(sessionId);
  if (local && existsSync(local)) return local;

  // (d) the hub's satellite mirror
  const hits = await glob(
    transcriptGlob(
      remoteRoot(), '*', 'codex', 'sessions', '**', `rollout-*-${sessionId}.jsonl`,
    ),
    { nodir: true },
  );
  for (const h of hits) if (existsSync(h)) return h;

  return null;
}
