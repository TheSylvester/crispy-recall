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
  // Two passes: a stale-lock takeover is performed by REMOVING the stale lock
  // and retrying the atomic O_EXCL (`wx`) create — so only one racer's create
  // can win. An unconditional overwrite (the previous approach) let every racer
  // that saw the lock as stale "win" simultaneously, spawning duplicate
  // ~1.5 GB llama-servers. A vanishingly small window remains (a racer's
  // unlink landing just after another's fresh create); the cost is one
  // transient extra server, self-healed on the next sweep, never corruption.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      // Lock exists — check liveness + age.
      let heldPid: number;
      let ageMs: number;
      try {
        heldPid = parseInt(readFileSync(LOCK_PATH, 'utf8'), 10);
        ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
      } catch {
        continue; // lock vanished mid-check — retry the create
      }
      if (isAlive(heldPid) && ageMs < STALE_MS) return false; // legitimate owner
      // Stale — drop it so the next iteration's exclusive create decides one winner.
      try { unlinkSync(LOCK_PATH); } catch { /* another racer already took over */ }
    }
  }
  return false;
}

/** Release the embed lock if it still belongs to this process. */
export function releaseEmbedLock(): void {
  try {
    const held = parseInt(readFileSync(LOCK_PATH, 'utf8'), 10);
    if (held === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* ignore */ }
}
