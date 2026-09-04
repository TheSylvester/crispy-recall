/**
 * codex-rekey-migration — the attended `codex_message_id_v2` migration (spec §5).
 *
 * Codex message ids used to be `codex-jsonl-<8 hex of session uuid>-<counter>`.
 * A UUIDv7 8-hex prefix is a ~65 s bucket, so sibling sessions shared ids and
 * `INSERT OR IGNORE` silently dropped their turns. The adapter now emits the
 * FULL uuid; this module rewrites the legacy rows.
 *
 * It re-ingests each affected session with `force: true`, one session per
 * transaction. A force re-ingest deletes the session's vectors in the same
 * transaction (message-store.ts:119-128), so the run de-vectorizes every
 * re-keyed session and prints `vectors dropped: N` — the attended caller MUST
 * follow with a drain (`embed-pending.js` / `recall backfill --auto-embed`).
 *
 * The marker is written LAST and always (even when some sessions could not be
 * re-ingested), because the gate exists to stop UNATTENDED rewrites, not to
 * block a hub whose oldest transcripts are gone.
 *
 * @module installer/codex-rekey-migration
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { glob } from 'glob';
import { getDb, isCodexRekeyPending, CODEX_REKEY_MIGRATION_KEY } from '../db.js';
import { dbPath, recallRoot, transcriptGlob } from '../paths.js';
import { findCodexSessionFile } from '../adapters/codex/codex-jsonl-reader.js';
import { ingestSessionMessages } from '../recall/message-ingest.js';
import { log } from '../log.js';

/** The `schema_meta` key that says every Codex message_id carries a full uuid. */
export const CODEX_REKEY_KEY = CODEX_REKEY_MIGRATION_KEY;

/**
 * WHERE fragment selecting LEGACY Codex ids only.
 *
 * A full-uuid id is `codex-jsonl-` + 8-4-4-4-12 + `-<counter>`; SQLite's `_`
 * wildcard matches exactly one character, so the NOT LIKE excludes precisely
 * the new shape and keeps every 8-hex row.
 */
export const LEGACY_CODEX_ID_SQL =
  `message_id LIKE 'codex-jsonl-%' AND ` +
  `message_id NOT LIKE 'codex-jsonl-________-____-____-____-____________-%'`;

export interface CodexRekeyResult {
  /** False when the marker was already 'complete' (idempotent re-run). */
  performed: boolean;
  /** Distinct sessions holding legacy ids at the start of the run. */
  sessions: number;
  /** Sessions re-ingested under full-uuid ids. */
  reingested: number;
  /** Sessions whose transcript could not be found anywhere. */
  fileGone: number;
  /** Vectors deleted by the force re-ingests (the drain gap this opens). */
  vectorsDropped: number;
  /** Distinct sessions still holding legacy ids after the run. */
  legacyRemaining: number;
}

/** Mirror root for the hub's satellite transcripts.
 *  // U2 replaces this with remoteRoot() from paths.ts */
function remoteRootForRekey(): string {
  return process.env['RECALL_REMOTE_ROOT'] ?? join(recallRoot(), 'remote');
}

/**
 * Resolve the rollout file for a session id. First hit wins:
 * provenance → watermark → `~/.codex/sessions` scan → mirror scan.
 */
async function resolveRollout(
  d: ReturnType<typeof getDb>,
  sessionId: string,
): Promise<string | null> {
  // (a) recorded provenance path
  const prov = d.get(
    `SELECT transcript_path AS p FROM session_provenance WHERE session_id = ?`,
    [sessionId],
  ) as { p?: string } | undefined;
  if (prov?.p && existsSync(prov.p)) return prov.p;

  // (b) a codex watermark whose basename names this session
  const marks = d.all(
    `SELECT transcript_path AS p FROM ingest_watermark WHERE vendor = 'codex'`,
  ) as Array<{ p: string }>;
  const wanted = new RegExp(`^rollout-.*-${sessionId}\\.jsonl$`);
  for (const m of marks) {
    if (wanted.test(basename(m.p)) && existsSync(m.p)) return m.p;
  }

  // (c) the local Codex sessions tree (honors CODEX_HOME)
  const local = findCodexSessionFile(sessionId);
  if (local && existsSync(local)) return local;

  // (d) the hub's satellite mirror
  const hits = await glob(
    transcriptGlob(
      remoteRootForRekey(), '*', 'codex', 'sessions', '**', `rollout-*-${sessionId}.jsonl`,
    ),
    { nodir: true },
  );
  for (const h of hits) if (existsSync(h)) return h;

  return null;
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
    performed: false, sessions: 0, reingested: 0, fileGone: 0,
    vectorsDropped: 0, legacyRemaining: 0,
  };
  if (!isCodexRekeyPending(d)) return result;
  result.performed = true;

  // Enumerate from `messages`, NEVER from session_provenance: on the live hub
  // 1,102 of 2,978 affected sessions have no provenance row at all.
  const sessions = (d.all(
    `SELECT DISTINCT session_id AS id FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`,
  ) as Array<{ id: string }>).map((r) => r.id);
  result.sessions = sessions.length;

  for (const id of sessions) {
    const path = await resolveRollout(d, id);
    if (!path) {
      result.fileGone++;
      say(`codex-rekey: transcript gone for ${id} — legacy ids kept`);
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
    if (r.sessionId !== id) {
      // classifySession resolved a different canonical id (the bounded
      // session_meta read newly exposes a >8 KB meta), so the rows under the
      // enumerated id were NOT replaced.
      say(`codex-rekey: ${id} reclassified to ${r.sessionId}; legacy rows under ${id} kept`);
      continue;
    }
    result.vectorsDropped += before;
    result.reingested++;
  }

  result.legacyRemaining = (d.get(
    `SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`,
  ) as { c: number } | undefined)?.c ?? 0;

  if (result.legacyRemaining !== result.fileGone) {
    const summary =
      `codex-rekey: ${result.legacyRemaining} sessions still carry legacy ids but only ` +
      `${result.fileGone} transcripts were missing (an ingest error is the usual cause)`;
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
    `${result.fileGone} transcripts gone, ${result.vectorsDropped} vectors dropped`,
  );
  return result;
}
