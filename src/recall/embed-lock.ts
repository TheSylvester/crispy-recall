/**
 * embed-lock — PID-tagged lockfile used to serialize embed loops across
 * the host. Extracted from embed-pending.ts so `catchup.ts`'s embedding
 * backfill can reuse the same primitive without duplicating the registry.
 *
 * Behavior matches the Day 3 inline implementation exactly:
 *   - Lock at ~/.recall/run/embed.lock, contents are the holder's PID.
 *   - tryAcquireEmbedLock() returns true if we now own the lock.
 *   - Stale takeover when the holder is dead OR mtime older than STALE_MS.
 *   - releaseEmbedLock() only unlinks when the PID still matches our own.
 *
 * @module recall/embed-lock
 */

import { writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../paths.js';

export const LOCK_PATH = join(runDir(), 'embed.lock');
export const STALE_MS = 30 * 60 * 1000; // 30 min

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Attempt to acquire the embed lock. Returns true on success. */
export function tryAcquireEmbedLock(): boolean {
  try {
    writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // Lock exists — check liveness + age
    try {
      const heldPid = parseInt(readFileSync(LOCK_PATH, 'utf8'), 10);
      const ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
      if (isAlive(heldPid) && ageMs < STALE_MS) return false; // legitimate owner
      // Stale — take over
      writeFileSync(LOCK_PATH, String(process.pid));
      return true;
    } catch {
      return false; // race; let the other process win
    }
  }
}

/** Release the embed lock if it still belongs to this process. */
export function releaseEmbedLock(): void {
  try {
    const held = parseInt(readFileSync(LOCK_PATH, 'utf8'), 10);
    if (held === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* ignore */ }
}
