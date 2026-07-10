/**
 * embed-pending — lockfile-protected child that drains unvectorized messages.
 *
 * Spawned detached by the Stop hook (and by ad-hoc CLI invocations / Day-4's
 * backfill orchestrator). The PID-tagged lockfile at ~/.recall/run/embed.lock
 * ensures at most one embed loop runs at a time across the host — keeping
 * exactly one llama-server resident (~1.5 GB) instead of N parallel copies.
 *
 * If the lock is held by a live owner, this process exits 0 silently — the
 * holder's loop sweeps cross-session via getUnembeddedMessages(), so our
 * session's messages get picked up without contention.
 *
 * Day 4 additions:
 *   - Lock primitives now come from `recall/embed-lock.ts` (shared with
 *     `runEmbeddingBackfill` in `recall/catchup.ts`).
 *   - 5-minute heartbeat keeps the lockfile mtime fresh during long sweeps,
 *     so a competing child doesn't see the lock as stale and start a second
 *     llama-server at minute 31+.
 *   - T2 sweep: at the tail of the embed loop (while we still hold the lock),
 *     run an mtimeScan() pass to ingest any JSONL the Stop hook missed, then
 *     re-enter the embed loop ONCE so freshly-ingested rows get vectorized
 *     in the same cycle — turning multi-hour Stop-hook outages into a single
 *     recovery cycle.
 *
 * @module cli/embed-pending
 */
import { mkdirSync, utimesSync } from "node:fs";
import { runDir } from "../paths.js";
import { embedSessionMessages, embedMessageBatch } from "../recall/message-ingest.js";
import { getUnembeddedMessages } from "../recall/message-store.js";
import { disposeEmbedder } from "../recall/embedder.js";
import { tryAcquireEmbedLock, releaseEmbedLock, LOCK_PATH } from "../recall/embed-lock.js";
import { mtimeScan } from "../recall/mtime-scan.js";

const CATCHUP_BATCH_SIZE = 80;
const MAX_CONSECUTIVE_FAILURES = 3;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

(async () => {
  // Ensure runDir() exists — paths.ts doesn't create subdirs, and the lockfile
  // write fails silently with ENOENT if ~/.recall/run/ is missing.
  mkdirSync(runDir(), { recursive: true });
  const sessionId = process.argv[2]; // optional; informational only
  if (!tryAcquireEmbedLock()) process.exit(0);
  process.on("exit", releaseEmbedLock);
  // On a signal, kill the llama-server BEFORE releasing the lock and exiting.
  // process.exit() bypasses the finally block, so without this a SIGINT/SIGTERM
  // would orphan the ~1.5 GB resident server.
  const onSignal = async () => {
    try { await disposeEmbedder(); } catch { /* ignore */ }
    releaseEmbedLock();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Heartbeat: touch the lockfile mtime so a long backfill (>30 min) doesn't
  // look stale to a competing child. unref() so the interval doesn't keep
  // the process alive on its own.
  const heartbeat = setInterval(() => {
    try { utimesSync(LOCK_PATH, new Date(), new Date()); } catch { /* ignore */ }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    // Embed the named session first (if provided), then sweep ALL unvectorized
    // messages cross-session — the query in getUnembeddedMessages isn't
    // session-scoped, so we naturally cover other sessions' gaps.
    //
    // Guard the whole embed phase: if the embedder is unavailable (e.g. the
    // binary/model isn't downloaded yet — the exact cold-install window where
    // catch-up matters most), the throw must NOT skip the T2 mtimeScan below.
    try {
      if (sessionId) {
        await embedSessionMessages(sessionId);
      }
      // Sweep loop: keep going while there's work and failures stay low.
      let consecutiveFailures = 0;
      while (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        const batch = getUnembeddedMessages(CATCHUP_BATCH_SIZE);
        if (batch.length === 0) break;
        try {
          await embedMessageBatch(batch);
          consecutiveFailures = 0;
        } catch {
          consecutiveFailures++;
        }
      }
    } catch {
      // Embedder unavailable — fall through to the T2 mtimeScan so FTS5
      // catch-up still runs while we hold the lock.
    }

    // T2: opportunistic mtime-scan while we still hold the lock.
    const scan = await mtimeScan();
    // If mtimeScan ingested any rows, those rows are FTS5-indexed but not yet
    // vectorized. Re-enter the embed sweep ONCE more to drain them before
    // exit — without this, fresh ingests leak to the next child and turn a
    // 1-cycle recovery into an N-cycle recovery.
    if (scan.ingested > 0) {
      let consecutiveFailures = 0;
      while (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        const batch = getUnembeddedMessages(CATCHUP_BATCH_SIZE);
        if (batch.length === 0) break;
        try {
          await embedMessageBatch(batch);
          consecutiveFailures = 0;
        } catch {
          consecutiveFailures++;
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
    // Kill llama-server BEFORE releasing the lock so the next embed-pending
    // child doesn't briefly run two servers in parallel (~1.5 GB each).
    // Guard with try/catch — disposeEmbedder throwing must not orphan the lock.
    try { await disposeEmbedder(); } catch { /* ignore */ }
    releaseEmbedLock();
  }
})().catch(() => {
  // A throw that escapes the loop (e.g. a pending-migration fail-closed DB
  // open inside mtimeScan) must not crash a detached background child with an
  // unhandled rejection — exit 0 quietly; the attended migration and the
  // next sweep pick the work back up.
  process.exit(0);
});
