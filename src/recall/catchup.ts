/**
 * Recall Catch-up — FTS5 catch-up + embedding backfill orchestration
 *
 * Three phases (plan §5.9):
 *   1. FTS5 catch-up: silently indexes all unindexed sessions (fast)
 *   2. Gap detection: counts messages without embedding vectors
 *   3. Embedding backfill: drains unvectorized rows via llama-embedding,
 *      gated on a `@clack/prompts` confirm when the gap exceeds
 *      SILENT_EMBED_THRESHOLD (skip with `--auto-embed`).
 *
 * Standalone wiring:
 *   - `listAllSessions` comes from `session-manager-shim.ts` (glob-backed).
 *   - Progress is written to stderr as one JSON event per line (the line
 *     is machine-readable when `RECALL_STATUS_JSON` is set, otherwise it
 *     carries a `[recall-catchup]` prefix).
 *   - `startRecallCatchup({ autoEmbed, vendors })` is the only public entry
 *     point — the user gate uses `@clack/prompts.confirm`.
 *   - `ingestSessionMessages` is called with the standalone's 4-arg form
 *     (`sessionId, path, vendor, options?`), reading vendor/path off the
 *     `ShimSessionInfo` returned by the shim.
 *
 * @module recall/catchup
 */

import { existsSync, utimesSync } from 'node:fs';
import { freemem } from 'node:os';
import { confirm, isCancel } from '@clack/prompts';
import { listAllSessions } from '../session-manager-shim.js';
import {
  getIndexedSessionIds,
  getEmbeddingGapStats,
  getUnembeddedMessages,
} from './message-store.js';
import { ingestSessionMessages, embedMessageBatch } from './message-ingest.js';
import { ensureModel, ensureBinary, disposeEmbedder } from './embedder.js';
import { tryAcquireEmbedLock, releaseEmbedLock, embedLockPath } from './embed-lock.js';
import { log } from '../log.js';

// ============================================================================
// Types
// ============================================================================

export type { CatchupStatus } from './catchup-types.js';
export { RECALL_CATCHUP_CHANNEL_ID } from './catchup-types.js';

import type { CatchupStatus } from './catchup-types.js';

/** Gap threshold: embed silently below this, prompt above. */
const SILENT_EMBED_THRESHOLD = 200;

/** System free memory threshold (MB) — stop embedding if free RAM drops below this. */
const FREE_MEM_FLOOR_MB = 1024;

/** Rough estimate: seconds per message for embedding with llama.cpp.
 * Server mode processes ~300-350 msg/min (~0.2s each). */
const SECONDS_PER_MESSAGE = 0.2;

/** Batch size for cross-session catch-up embedding. */
const CATCHUP_BATCH_SIZE = 80;

/** Stop embedding after this many consecutive batch failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

// ============================================================================
// Module State
// ============================================================================

let status: CatchupStatus = {
  phase: 'idle',
  gapCount: 0,
  totalMessages: 0,
  embeddedSoFar: 0,
  estimatedSecondsRemaining: 0,
};

/** Cancellation flag for embedding backfill. */
let cancelRequested = false;

/** Whether a catch-up run is currently in progress. */
let running = false;

// ============================================================================
// Stderr status writer (replaces the host-side broadcast channel)
// ============================================================================

function writeStatus(event: Record<string, unknown>): void {
  // Updates module status for any field that belongs on CatchupStatus, then
  // emits the event to stderr (machine-readable when RECALL_STATUS_JSON is set).
  const STATUS_KEYS = new Set([
    'phase', 'gapCount', 'totalMessages', 'embeddedSoFar',
    'estimatedSecondsRemaining', 'stoppedByMemoryPressure', 'stoppedByError',
  ]);
  const statusPatch: Record<string, unknown> = {};
  for (const k of Object.keys(event)) {
    if (STATUS_KEYS.has(k)) statusPatch[k] = event[k];
  }
  Object.assign(status, statusPatch);
  const line = process.env['RECALL_STATUS_JSON']
    ? JSON.stringify(event) + '\n'
    : `[recall-catchup] ${JSON.stringify(event)}\n`;
  process.stderr.write(line);
}

// ============================================================================
// Cancel flag exports (used by `recall backfill`'s SIGINT handler)
// ============================================================================

export function setCancelFlag(): void { cancelRequested = true; }
export function clearCancelFlag(): void { cancelRequested = false; }

// ============================================================================
// Lock heartbeat
// ============================================================================

function startLockHeartbeat(lockPath: string): NodeJS.Timeout {
  const t = setInterval(() => {
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* ignore */ }
  }, 5 * 60 * 1000);
  t.unref();
  return t;
}

// ============================================================================
// FTS5 Catch-up
// ============================================================================

export async function runFts5Catchup(opts?: { vendors?: ('claude' | 'codex')[] }): Promise<void> {
  writeStatus({ phase: 'fts5-indexing' });

  const sessions = listAllSessions({ vendors: opts?.vendors });
  const alreadyIndexed = getIndexedSessionIds();
  let indexed = 0;

  let processed = 0;
  for (const s of sessions) {
    if (cancelRequested) return;
    if (s.isSidechain) continue;
    if (alreadyIndexed.has(s.sessionId)) continue;
    if (!existsSync(s.path)) continue;

    try {
      const result = await ingestSessionMessages(s.sessionId, s.path, s.vendor);
      if (!result.skipped && !result.error) {
        indexed += result.chunksCreated;
      }
    } catch {
      // Non-fatal — skip and continue
    }

    // Yield to the event loop every 10 sessions to avoid starving callers.
    if (++processed % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (indexed > 0) {
    log({
      source: 'recall-catchup',
      level: 'info',
      summary: `FTS5 catch-up: ${indexed} messages indexed`,
    });
  }
}

// ============================================================================
// Embedding Backfill
// ============================================================================

function memoryPressure(): boolean {
  const freeMB = Math.round(freemem() / 1024 / 1024);
  const under = freeMB < FREE_MEM_FLOOR_MB;
  if (under) {
    log({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Memory pressure: ${freeMB} MB free < ${FREE_MEM_FLOOR_MB} MB floor`,
    });
  }
  return under;
}

/**
 * Run embedding backfill on unvectorized messages across all sessions.
 *
 * Acquires the shared embed lock (so no parallel llama-server). Skips Phase 3
 * silently if the lock is contested — Phase 1 (FTS5) and Phase 2 (gap stats)
 * already ran outside this function, so the only thing the contested caller
 * "loses" is the embed pass that the lock-holder will run anyway.
 */
export async function runEmbeddingBackfill(): Promise<void> {
  if (!tryAcquireEmbedLock()) {
    writeStatus({ phase: 'embedding', note: 'another embed process holds the lock — yielding' });
    return;
  }

  const heartbeat = startLockHeartbeat(embedLockPath());

  try {
    // Download binary + model if needed
    writeStatus({ phase: 'downloading-model', stoppedByMemoryPressure: false, stoppedByError: undefined });
    try {
      await ensureBinary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ source: 'recall-catchup', level: 'warn', summary: `Binary download failed: ${msg}` });
      writeStatus({ phase: 'done', gapCount: status.gapCount, stoppedByError: `Binary download failed: ${msg}` });
      return;
    }
    try {
      await ensureModel();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ source: 'recall-catchup', level: 'warn', summary: `Model download failed: ${msg}` });
      writeStatus({ phase: 'done', gapCount: status.gapCount, stoppedByError: `Model download failed: ${msg}` });
      return;
    }

    writeStatus({ phase: 'embedding', embeddedSoFar: 0 });

    let totalEmbedded = 0;
    let consecutiveFailures = 0;
    const embedStartTime = Date.now();

    while (!cancelRequested && !memoryPressure()) {
      // Fetch 2 batches worth of messages, split into concurrent work
      const allMessages = getUnembeddedMessages(CATCHUP_BATCH_SIZE * 2);
      if (allMessages.length === 0) break;

      // Split into up to 2 batches for concurrent processing
      const batches: Array<typeof allMessages> = [];
      for (let i = 0; i < allMessages.length; i += CATCHUP_BATCH_SIZE) {
        batches.push(allMessages.slice(i, i + CATCHUP_BATCH_SIZE));
      }

      try {
        const results = await Promise.all(batches.map(b => embedMessageBatch(b)));
        const batchTotal = results.reduce((sum, n) => sum + n, 0);
        totalEmbedded += batchTotal;
        consecutiveFailures = 0;

        const elapsed = (Date.now() - embedStartTime) / 1000;
        const rate = totalEmbedded / elapsed;
        const remaining = status.gapCount - totalEmbedded;
        const estSeconds = rate > 0 ? Math.round(remaining / rate) : 0;
        writeStatus({
          embeddedSoFar: totalEmbedded,
          estimatedSecondsRemaining: Math.max(0, estSeconds),
        });
      } catch (err) {
        consecutiveFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        log({
          source: 'recall-catchup',
          level: 'warn',
          summary: `Embed batch failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${msg}`,
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log({
            source: 'recall-catchup',
            level: 'warn',
            summary: `Embedding stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
          });
          const shortMsg = msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
          writeStatus({ stoppedByError: `Embedding failed repeatedly — ${shortMsg}` });
          break;
        }
      }
    }

    if (!cancelRequested && memoryPressure()) {
      writeStatus({ stoppedByMemoryPressure: true });
    }

    log({
      source: 'recall-catchup',
      level: 'info',
      summary: `runEmbeddingBackfill complete — ${totalEmbedded} messages vectorized`,
      data: { totalEmbedded, cancelled: cancelRequested },
    });

    const { gapCount, totalMessages } = getEmbeddingGapStats();
    writeStatus({ phase: 'done', gapCount, totalMessages, estimatedSecondsRemaining: 0 });
  } finally {
    clearInterval(heartbeat);
    // Kill llama-server BEFORE releasing the lock so the next embed-pending
    // child doesn't briefly run two servers in parallel (~1.5 GB each).
    try { await disposeEmbedder(); } catch { /* ignore */ }
    releaseEmbedLock();
  }
}

// ============================================================================
// Public API
// ============================================================================

export interface StartCatchupOptions {
  autoEmbed?: boolean;
  vendors?: ('claude' | 'codex')[];
}

/**
 * Standalone entry point — call from `recall backfill` (T3) or the installer.
 * The auto-catch-up rail (Stop hook → embed-pending → T2) does NOT pass
 * through here.
 */
export async function startRecallCatchup(opts: StartCatchupOptions = {}): Promise<void> {
  log({
    source: 'recall-catchup',
    level: 'info',
    summary: 'startRecallCatchup called',
    data: { autoEmbed: !!opts.autoEmbed, vendors: opts.vendors ?? ['claude', 'codex'] },
  });

  if (running) {
    log({ source: 'recall-catchup', level: 'warn', summary: 'startRecallCatchup blocked — already running' });
    return;
  }
  running = true;
  cancelRequested = false;

  try {
    // Phase 1: FTS5 catch-up (fast, silent)
    await runFts5Catchup({ vendors: opts.vendors });

    if (cancelRequested) return;

    // Phase 2: Gap detection
    const { gapCount, totalMessages } = getEmbeddingGapStats();
    log({
      source: 'recall-catchup',
      level: 'info',
      summary: 'Gap detection complete',
      data: { gapCount, totalMessages },
    });
    writeStatus({
      phase: 'detecting-gap',
      gapCount,
      totalMessages,
      estimatedSecondsRemaining: gapCount * SECONDS_PER_MESSAGE,
    });

    if (gapCount === 0) {
      log({ source: 'recall-catchup', level: 'info', summary: 'No embedding gap — nothing to do' });
      writeStatus({ phase: 'done' });
      return;
    }

    // Phase 3: Decision — silent embed or prompt
    if (gapCount <= SILENT_EMBED_THRESHOLD) {
      log({
        source: 'recall-catchup',
        level: 'info',
        summary: `Small gap (${gapCount}) — embedding silently`,
      });
      await runEmbeddingBackfill();
    } else if (opts.autoEmbed) {
      log({
        source: 'recall-catchup',
        level: 'info',
        summary: `Large gap (${gapCount}) — auto-embed enabled, proceeding`,
      });
      await runEmbeddingBackfill();
    } else {
      const mins = Math.ceil(gapCount * SECONDS_PER_MESSAGE / 60);
      const proceed = await confirm({
        message: `Embed ${gapCount} pending messages now? (≈${mins} min)`,
        initialValue: true,
      });
      if (isCancel(proceed) || !proceed) {
        writeStatus({ phase: 'embed-skipped', gap: gapCount });
        return;
      }
      await runEmbeddingBackfill();
    }
  } catch (err) {
    log({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Catch-up failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    running = false;
  }
}
