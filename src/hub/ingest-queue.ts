/**
 * Push-time ingest (spec §2.4) and the single in-process queue that runs it.
 *
 * One job at a time, the HTTP response already sent. The queue is what the
 * query path awaits ("no queued or in-flight entry for the requesting host")
 * so a satellite's own just-pushed turn is searchable on its very next query.
 *
 * Steps 2a-2e are in `runPushIngest`, with the side effects (embed-pending
 * spawn, hub.log, refused-collision counter) injected so tests can observe
 * them without a daemon.
 *
 * @module hub/ingest-queue
 */

import { getDb } from '../db.js';
import { dbPath } from '../paths.js';
import { classifySession } from '../recall/session-classifier.js';
import { ingestSessionMessages } from '../recall/message-ingest.js';
import { sessionIdFromPath } from '../recall/mtime-scan.js';
import { upgradeLocalPathKey } from '../recall/project-key.js';
import { mirrorHostPrefix } from './mirror.js';
import type { AppendMeta, HubVendor } from './protocol.js';

export interface PushIngestJob {
  host: string;
  vendor: HubVendor;
  /** `/`-normalized vendor-relative path. */
  rel: string;
  /** `mirrorFilePath(host, vendor, rel)` — the watermark key. */
  abs: string;
  /** From the stat taken for the 200 (pre-ingest). */
  mtimeInt: number;
  size: number;
  meta: AppendMeta;
  /** The request carried `reset` — the ONLY case that passes `force: true`. */
  reset: boolean;
}

export interface PushIngestDeps {
  /** Detached `embed-pending.js <canonicalId>` spawn (stop-hook.ts idiom). */
  spawnEmbed: (canonicalId: string) => void;
  /** One hub.log line. */
  log: (line: string) => void;
  /** `refusedCollisions++` for the host, and `sid` onto its recent list (D5). */
  onRefused: (host: string, sid: string) => void;
}

export type PushIngestOutcome = 'ingested' | 'refused' | 'failed' | 'skipped';

/**
 * The stored `session_provenance.transcript_path` for `canonicalId` when it
 * lies OUTSIDE `<remoteRoot()>/<host>/` (another machine's session), else
 * null. Shared by the push path and the mirror sweep guard.
 */
export function findCollision(canonicalId: string, host: string): string | null {
  const row = getDb(dbPath()).get(
    'SELECT transcript_path FROM session_provenance WHERE session_id = ? LIMIT 1',
    [canonicalId],
  ) as { transcript_path: string | null } | undefined;
  const existing = row?.transcript_path ?? null;
  if (existing === null) return null;
  return existing.startsWith(mirrorHostPrefix(host)) ? null : existing;
}

/** Steps 2a-2e of spec §2.4. Never throws. */
export async function runPushIngest(job: PushIngestJob, deps: PushIngestDeps): Promise<PushIngestOutcome> {
  const db = getDb(dbPath());

  // 2b. Session id from the `/`-normalized rel; canonical id via classifySession FIRST.
  const sessionId = sessionIdFromPath(job.rel, job.vendor);
  let canonicalId: string;
  try {
    const classification = classifySession({
      sessionId, transcriptPath: job.abs, vendor: job.vendor, hook: job.meta.hook,
    });
    if (classification.unresolvable) {
      deps.log(`push-ingest-skipped host=${job.host} path=${job.rel} reason=unresolvable-subagent`);
      return 'skipped';
    }
    canonicalId = classification.canonicalSessionId;
  } catch (e) {
    deps.log(`push-ingest-failed host=${job.host} path=${job.rel} err=${(e as Error).message}`);
    return 'failed';
  }

  // Collision check: stored provenance for the canonical id that points
  // OUTSIDE this host's mirror is another machine's session. Refuse — with
  // `force` a merge would DELETE the hub's rows for that session (S11).
  let existing: string | null;
  try {
    existing = findCollision(canonicalId, job.host);
  } catch (e) {
    deps.log(`push-ingest-failed host=${job.host} path=${job.rel} err=${(e as Error).message}`);
    return 'failed';
  }
  if (existing !== null) {
    deps.log(`session-id collision host=${job.host} sid=${canonicalId} existing=${existing}`);
    deps.onRefused(job.host, canonicalId);
    return 'refused';
  }

  // 2c. Ingest with the vendor from the URL; force ONLY for a reset request.
  //     A `path:` key the hub owns is upgraded first: a Windows satellite that
  //     works on a WSL repository saw the hub's own filesystem through a
  //     mount, so it could key only the path. The hub knows the repository.
  const key = job.meta.key === undefined ? undefined : upgradeLocalPathKey(job.meta.key);
  if (key !== undefined && key !== job.meta.key) {
    deps.log(`key-upgraded host=${job.host} path=${job.rel} from=${job.meta.key} to=${key}`);
  }
  let result;
  try {
    result = await ingestSessionMessages(sessionId, job.abs, job.vendor, {
      ...(job.meta.cwd !== undefined ? { projectId: job.meta.cwd } : {}),
      ...(key !== undefined ? { projectKey: key } : {}),
      ...(job.meta.hook !== undefined ? { hook: job.meta.hook } : {}),
      force: job.reset,
    });
  } catch (e) {
    deps.log(`push-ingest-failed host=${job.host} path=${job.rel} err=${(e as Error).message}`);
    return 'failed';
  }
  if (result.error) {
    deps.log(`push-ingest-failed host=${job.host} path=${job.rel} err=${result.error}`);
    return 'failed';
  }

  // M2: the identity a LATER chunk taught us is adopted by the session's
  // NULL-identity rows INSIDE the ingest transaction (message-store.ts
  // `adopt`), so a failed adoption is a failed ingest: no watermark below,
  // and the next sweep re-ingests the mirror with its sidecar key.

  // 2d. Watermark only after a clean ingest (advance-then-ingest drops turns).
  try {
    db.run(
      `INSERT INTO ingest_watermark (transcript_path, last_mtime, last_size, vendor)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(transcript_path) DO UPDATE SET last_mtime=excluded.last_mtime, last_size=excluded.last_size`,
      [job.abs, job.mtimeInt, job.size, job.vendor],
    );
  } catch (e) {
    deps.log(`push-ingest-failed host=${job.host} path=${job.rel} err=watermark: ${(e as Error).message}`);
    return 'failed';
  }
  deps.log(`push-ingested host=${job.host} path=${job.rel} sid=${result.sessionId} rows=${result.chunksCreated}`);

  // 2e. Embed trigger, skipped for subagent hooks and agent leaves.
  if (!job.meta.hook?.isSubagent && result.retrievalClass !== 'agent') {
    try { deps.spawnEmbed(result.sessionId); } catch { /* best-effort */ }
  }
  return 'ingested';
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface QueuedJob {
  /** Host the job belongs to; `null` for a sweep (nobody waits on it by host). */
  host: string | null;
  run: () => Promise<void>;
}

export class IngestQueue {
  private queue: QueuedJob[] = [];
  private current: QueuedJob | null = null;
  private waiters: Array<() => void> = [];

  enqueue(host: string | null, run: () => Promise<void>): void {
    this.queue.push({ host, run });
    void this.pump();
  }

  /** Queued + in-flight jobs. */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  hasHost(host: string): boolean {
    return this.current?.host === host || this.queue.some((j) => j.host === host);
  }

  /** Resolve true when no job for `host` remains; false on the cap. */
  waitForHost(host: string, capMs: number): Promise<boolean> {
    return this.waitUntil(() => !this.hasHost(host), capMs);
  }

  /** Resolve true when the queue is empty and nothing is in flight. */
  idle(capMs: number): Promise<boolean> {
    return this.waitUntil(() => this.pending === 0, capMs);
  }

  private async waitUntil(done: () => boolean, capMs: number): Promise<boolean> {
    const deadline = Date.now() + capMs;
    while (!done()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const fired = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== wake); resolve(false); }, remaining);
        const wake = (): void => { clearTimeout(t); resolve(true); };
        this.waiters.push(wake);
      });
      if (!fired) return done();
    }
    return true;
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    while (this.queue.length > 0) {
      this.current = this.queue.shift()!;
      try {
        await this.current.run();
      } catch { /* the job logs its own failure */ }
      this.current = null;
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }
}
