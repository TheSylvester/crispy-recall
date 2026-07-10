/**
 * retrieval-class-migration — attended, in-place migration of an existing
 * recall DB to the retrieval-class schema (agent leaves cold-but-durable,
 * filtered external-content FTS, provenance tables, durable marker).
 *
 * History-preserving, crash-safe, idempotent, WAL-model-safe:
 *
 *   - Runs ONLY from `recall install` (normal commands fail closed via the
 *     getDb marker gate — see db.ts MigrationPendingError).
 *   - QUIESCES the background embedding drain first: a live embed.lock owner
 *     or a running detached backfill aborts with remediation — an in-flight
 *     drain runs the old unfiltered selectors and could race the purge
 *     (insertMessageVectors' always-on hot-guard is the second line of
 *     defense; this is the cross-process first line).
 *   - Takes a WAL-SAFE snapshot via SQLite's online backup API — page-exact
 *     (rowids preserved, so the external-content FTS stays valid on restore)
 *     and inclusive of committed-but-uncheckpointed WAL frames. A failed
 *     snapshot ABORTS the migration.
 *   - One BEGIN IMMEDIATE transaction: add column → provenance tables → drop
 *     the OLD unfiltered triggers BEFORE mass classification (else every
 *     class flip would reindex rows we are about to discard) → drop
 *     vocab/fts → classify → create filtered view/fts/triggers/vocab →
 *     rebuild → RANK-1 integrity-check → purge agent vectors → write the
 *     durable marker → COMMIT. Rollback restores the old schema intact
 *     (proven in test/unit/fts-filtered-view.test.ts), and concurrent openers
 *     can never observe a half-migrated state (marker commits atomically with
 *     everything else).
 *   - Never deletes message text or IDs. Historical classification uses
 *     confident evidence only: Claude `agent-*` session ids, and extant Codex
 *     rollouts whose session_meta carries subagent provenance. A Codex-shaped
 *     session whose transcript is gone is LEFT HOT and counted as unresolved
 *     — reported, never guessed.
 *
 * @module installer/retrieval-class-migration
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  getDb, _resetDb, isRetrievalMigrationPending, RETRIEVAL_MIGRATION_KEY, RETRIEVAL_SCHEMA_DDL,
  type RecallDb,
} from '../db.js';
import { dbPath, binDir, runDir } from '../paths.js';
import { embedLockPath } from '../recall/embed-lock.js';
import { backfillAlreadyRunning } from './upgrade-migrate.js';
import { backupStamp } from './settings-merge.js';
import { extractCodexSessionMeta, scanCodexSessionFiles } from '../adapters/codex/codex-jsonl-reader.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Detection (read-only)
// ---------------------------------------------------------------------------

/** Read-only: does the DB at dbPath() need the retrieval-class migration?
 *  False for absent/fresh DBs (they initialize new-generation directly). */
export function retrievalMigrationPending(): boolean {
  const dbFile = dbPath();
  if (!existsSync(dbFile)) return false;
  const raw = openRaw(dbFile, { readonly: true });
  if (!raw) return true; // unreadable → treat as pending; install surfaces it
  try {
    const hasMessages = raw
      .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='messages'`)
      .get();
    if (!hasMessages) return false;
    try {
      const marker = raw
        .prepare(`SELECT value FROM schema_meta WHERE key=?`)
        .get(RETRIEVAL_MIGRATION_KEY) as { value?: string } | undefined;
      return marker?.value !== 'complete';
    } catch {
      return true; // no schema_meta table
    }
  } catch {
    return true;
  } finally {
    try { raw.close(); } catch { /* ignore */ }
  }
}

/** Open a raw better-sqlite3 handle, staged-binding first (bundled runtime
 *  has no node_modules) — mirrors upgrade-migrate.ts openReadonly. */
function openRaw(dbFile: string, opts: { readonly: boolean }): Database.Database | null {
  const staged = join(binDir(), 'better_sqlite3.node');
  const options = { readonly: opts.readonly, fileMustExist: true } as const;
  try {
    return existsSync(staged)
      ? new Database(dbFile, { ...options, nativeBinding: staged })
      : new Database(dbFile, options);
  } catch {
    try {
      return new Database(dbFile, options);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Drain quiesce
// ---------------------------------------------------------------------------

/** Typed abort so install.ts can print remediation without a stack trace. */
export class RetrievalMigrationAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalMigrationAbort';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * The migration must not run while a background drain can write vectors with
 * the OLD unfiltered selectors. Waits briefly for a live embed.lock holder to
 * release, then aborts with remediation. A running detached backfill aborts
 * immediately (it can hold the lock for hours).
 */
async function quiesceDrain(waitMs: number): Promise<void> {
  if (backfillAlreadyRunning()) {
    throw new RetrievalMigrationAbort(
      'A background backfill is running (see `recall status`). Wait for it to finish ' +
        '(or stop it), then re-run `recall install` to complete the migration.',
    );
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    let raw: string | null = null;
    try {
      raw = readFileSync(embedLockPath(), 'utf8');
    } catch {
      return; // no lock — quiesced
    }
    const holder = parseInt(raw, 10);
    if (Number.isInteger(holder) && holder > 0) {
      if (!pidAlive(holder)) return; // dead holder; the migration owns the DB now
      if (Date.now() >= deadline) {
        throw new RetrievalMigrationAbort(
          `A background embedding drain is running (PID ${holder}, ${embedLockPath()}). ` +
            'Wait for it to finish (or stop it), then re-run `recall install` to complete the migration.',
        );
      }
    } else if (Date.now() >= deadline) {
      // Unparseable for the whole wait window → a corrupt remnant, not a live
      // drain mid-create (that write settles in microseconds). Proceed — the
      // always-on hot-guard on insertMessageVectors is the backstop.
      return;
    }
    // Unparseable (a `wx` create-then-write window) or live holder: retry.
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// WAL-safe snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot via SQLite's online backup API. Unlike a bare file copy this is
 * WAL-correct (committed frames included) and page-exact (rowids preserved —
 * load-bearing for the external-content FTS index on restore). THROWS on any
 * failure: the migration must not proceed without a rollback artifact.
 */
export async function snapshotDbWalSafe(): Promise<string> {
  const dbFile = dbPath();
  const dest = join(dirname(dbFile), `recall.db.pre-retrieval-${backupStamp()}`);
  const raw = openRaw(dbFile, { readonly: true });
  if (!raw) {
    throw new RetrievalMigrationAbort(
      `Could not open ${dbFile} to take the pre-migration snapshot — aborting (nothing was modified).`,
    );
  }
  try {
    await raw.backup(dest);
  } catch (e) {
    try { unlinkSync(dest); } catch { /* partial snapshot from THIS attempt only */ }
    throw new RetrievalMigrationAbort(
      `Pre-migration snapshot failed (${(e as Error).message}) — aborting (nothing was modified). ` +
        'Free disk space or fix permissions, then re-run `recall install`.',
    );
  } finally {
    try { raw.close(); } catch { /* ignore */ }
  }
  if (!existsSync(dest)) {
    throw new RetrievalMigrationAbort('Pre-migration snapshot missing after backup — aborting.');
  }
  return dest;
}

// ---------------------------------------------------------------------------
// Historical classification evidence
// ---------------------------------------------------------------------------

interface CodexChildEvidence {
  sessionId: string;
  parentSessionId: string | null;
  depth: number | null;
  transcriptPath: string;
}

interface CodexEvidence {
  children: CodexChildEvidence[];
  /** Canonical ids of extant transcripts confidently classified ROOT. */
  roots: Set<string>;
}

/** Walk extant Codex rollouts (live sessions dir + watermarked paths) and
 *  classify each from its own session_meta. Confident evidence only. */
function collectCodexEvidence(d: RecallDb): CodexEvidence {
  const paths = new Set<string>();
  try {
    for (const f of scanCodexSessionFiles()) paths.add(f.filepath);
  } catch { /* best-effort */ }
  try {
    const rows = d.all(
      `SELECT transcript_path FROM ingest_watermark WHERE vendor = 'codex'`,
    ) as Array<{ transcript_path: string }>;
    for (const r of rows) paths.add(r.transcript_path);
  } catch { /* watermark may not exist on very old DBs */ }

  const children: CodexChildEvidence[] = [];
  const roots = new Set<string>();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const meta = extractCodexSessionMeta(p);
    if (!meta?.id) continue;
    const sub = meta.source && typeof meta.source === 'object'
      ? (meta.source as { subagent?: unknown }).subagent
      : undefined;
    if (sub !== undefined && (typeof sub !== 'object' || sub === null)) {
      log({
        source: 'installer/retrieval-migration',
        level: 'warn',
        summary: `malformed subagent provenance in ${p} — leaving session hot (conservative)`,
      });
      roots.add(meta.id);
      continue;
    }
    if (sub) {
      const spawn = (sub as Record<string, unknown>).thread_spawn;
      const spawnObj = spawn && typeof spawn === 'object' ? spawn as Record<string, unknown> : {};
      children.push({
        sessionId: meta.id,
        parentSessionId: typeof spawnObj.parent_thread_id === 'string' ? spawnObj.parent_thread_id : null,
        depth: typeof spawnObj.depth === 'number' ? spawnObj.depth : null,
        transcriptPath: p.replace(/\\/g, '/'),
      });
    } else {
      roots.add(meta.id);
    }
  }
  return { children, roots };
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

export interface RetrievalMigrationResult {
  performed: boolean;
  snapshotPath?: string;
  /** Sessions classified cold (Claude agent-* + confident Codex children). */
  agentSessions: number;
  /** Message rows flipped to retrieval_class='agent'. */
  agentMessages: number;
  /** Vectors deleted for agent rows. */
  purgedVectors: number;
  /** Codex-shaped sessions whose transcripts are gone — LEFT HOT, reported. */
  unresolvedCodexSessions: number;
}

export interface RetrievalMigrationOptions {
  /** How long to wait for a live embed.lock holder before aborting. */
  drainWaitMs?: number;
}

/**
 * Run the attended migration. Idempotent: a completed DB returns
 * `{ performed: false }` immediately. Throws RetrievalMigrationAbort with a
 * user-facing remediation on any unsafe precondition; throws raw errors on
 * unexpected failures (transaction rolls back either way).
 */
export async function runRetrievalClassMigration(
  opts: RetrievalMigrationOptions = {},
): Promise<RetrievalMigrationResult> {
  const none: RetrievalMigrationResult = {
    performed: false, agentSessions: 0, agentMessages: 0, purgedVectors: 0, unresolvedCodexSessions: 0,
  };
  if (!retrievalMigrationPending()) return none;

  // 1. Quiesce the cross-process drain (hooks are already quiesced by install).
  await quiesceDrain(opts.drainWaitMs ?? 10_000);

  // 2. WAL-safe snapshot — failure ABORTS (throws) before any mutation.
  const snapshotPath = await snapshotDbWalSafe();

  // 3. Open in installer mode (marker gate bypassed; ensureSchema skipped —
  //    THIS function owns all DDL against the old schema).
  const d = getDb(dbPath(), { allowPendingMigration: true });
  d.exec('PRAGMA busy_timeout = 30000');

  // Re-check on the live connection: another installer may have completed it
  // between our readonly probe and now (the install lock should prevent this,
  // but the marker is the source of truth).
  if (!isRetrievalMigrationPending(d)) return { ...none, snapshotPath };

  const result: RetrievalMigrationResult = { ...none, performed: true, snapshotPath };

  d.exec('BEGIN IMMEDIATE');
  try {
    // 4. Schema/provenance support, idempotently.
    const hasClass = (d.all(`PRAGMA table_info(messages)`) as Array<{ name: string }>)
      .some((c) => c.name === 'retrieval_class');
    if (!hasClass) {
      d.exec(`ALTER TABLE messages ADD COLUMN retrieval_class TEXT NOT NULL DEFAULT 'hot'`);
    }
    d.exec(RETRIEVAL_SCHEMA_DDL.tables); // provenance/aliases/schema_meta (messages CREATE no-ops)

    // 5. Drop the OLD unconditional FTS triggers BEFORE mass classification —
    //    live old triggers would reindex every row the UPDATE below flips.
    d.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    d.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
    d.exec('DROP TRIGGER IF EXISTS messages_fts_au');
    d.exec('DROP TABLE IF EXISTS messages_fts_vocab');
    d.exec('DROP TABLE IF EXISTS messages_fts');

    // 6. Classify.
    // 6a. Claude agent-* leaves: confidently cold.
    const claudeLeaves = (d.all(
      `SELECT DISTINCT session_id FROM messages WHERE session_id LIKE 'agent-%'`,
    ) as Array<{ session_id: string }>).map((r) => r.session_id);
    // Parent enrichment from watermarked subagent paths where available.
    const claudeParents = new Map<string, { parent: string | null; path: string | null }>();
    try {
      const wm = d.all(
        `SELECT transcript_path FROM ingest_watermark WHERE vendor = 'claude'`,
      ) as Array<{ transcript_path: string }>;
      for (const r of wm) {
        const norm = r.transcript_path.replace(/\\/g, '/');
        const m = /\/([^/]+)\/subagents\/(agent-[^/]+)\.jsonl$/i.exec(norm);
        if (m) claudeParents.set(m[2]!, { parent: m[1]!, path: norm });
      }
    } catch { /* enrichment only */ }

    // 6b. Codex children from extant transcript metadata.
    const codex = collectCodexEvidence(d);
    const codexChildIds = codex.children.map((c) => c.sessionId);

    const agentSessions = [...new Set([...claudeLeaves, ...codexChildIds])];
    let agentMessages = 0;
    if (agentSessions.length > 0) {
      const flip = d.prepare(
        `UPDATE messages SET retrieval_class = 'agent' WHERE session_id = ? AND retrieval_class != 'agent'`,
      );
      for (const sid of agentSessions) {
        agentMessages += Number((flip.run([sid]) as { changes?: number }).changes ?? 0);
      }
    }
    result.agentSessions = agentSessions.length;
    result.agentMessages = agentMessages;

    // Durable provenance for everything classified (and confident roots).
    const upsertProv = d.prepare(
      `INSERT INTO session_provenance (session_id, vendor, kind, parent_session_id, agent_depth, transcript_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         kind = excluded.kind,
         parent_session_id = COALESCE(excluded.parent_session_id, session_provenance.parent_session_id),
         agent_depth = COALESCE(excluded.agent_depth, session_provenance.agent_depth),
         transcript_path = COALESCE(excluded.transcript_path, session_provenance.transcript_path),
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    for (const sid of claudeLeaves) {
      const enrich = claudeParents.get(sid);
      upsertProv.run([sid, 'claude', 'agent', enrich?.parent ?? null, null, enrich?.path ?? null, now]);
    }
    for (const c of codex.children) {
      upsertProv.run([c.sessionId, 'codex', 'agent', c.parentSessionId, c.depth, c.transcriptPath, now]);
    }

    // 6c. Unresolved: codex-shaped sessions (codex-jsonl-* message ids) that
    // are neither classified cold nor matched by an extant transcript. LEFT
    // HOT — reported, never guessed.
    const codexShaped = (d.all(
      `SELECT DISTINCT session_id FROM messages WHERE message_id LIKE 'codex-jsonl-%'`,
    ) as Array<{ session_id: string }>).map((r) => r.session_id);
    const accounted = new Set([...agentSessions, ...codex.roots]);
    result.unresolvedCodexSessions = codexShaped.filter((s) => !accounted.has(s)).length;

    // 7. Filtered view + FTS + four-state triggers + vocab, rebuild, verify.
    d.exec(RETRIEVAL_SCHEMA_DDL.fts);
    d.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    // RANK-1 integrity form — the rank-less form does not compare an
    // external-content index against its (filtered) source and passes silently.
    d.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)`);

    // 8. Purge vectors belonging to agent rows (history/message text is kept;
    //    the always-on hot-guard on insertMessageVectors prevents a racing
    //    drain from re-adding them afterwards).
    const purged = d.run(
      `DELETE FROM message_vectors WHERE message_id IN
       (SELECT message_id FROM messages WHERE retrieval_class = 'agent')`,
    ) as { changes?: number };
    result.purgedVectors = Number(purged.changes ?? 0);

    // 9. Durable marker — atomically with everything above.
    d.run(
      `INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'complete')`,
      [RETRIEVAL_MIGRATION_KEY],
    );

    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }

  // 10. Reopen NORMALLY: the marker is durable now, so the standard
  // ensureSchema pass reconciles the remaining generic objects (_stem helper,
  // embed_version ALTER) exactly as any fresh process would.
  _resetDb();
  const post = getDb(dbPath());

  // 11. Post-commit verification (report-only; snapshot is retained regardless).
  const integ = post.get('PRAGMA integrity_check') as Record<string, unknown> | undefined;
  const integDetail = integ ? String(Object.values(integ)[0] ?? '') : 'unknown';
  const fk = post.all('PRAGMA foreign_key_check') as unknown[];
  if (integDetail !== 'ok' || fk.length > 0) {
    log({
      source: 'installer/retrieval-migration',
      level: 'warn',
      summary: `post-migration checks: integrity='${integDetail}', fk violations=${fk.length} — rollback snapshot retained at ${snapshotPath}`,
    });
  }

  log({
    source: 'installer/retrieval-migration',
    level: 'info',
    summary:
      `retrieval-class migration complete: ${result.agentSessions} agent sessions ` +
      `(${result.agentMessages} messages) reclassified, ${result.purgedVectors} vectors purged, ` +
      `${result.unresolvedCodexSessions} unresolved codex-shaped sessions left hot; snapshot ${snapshotPath}`,
  });

  return result;
}
