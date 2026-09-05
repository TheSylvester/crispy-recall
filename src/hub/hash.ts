/**
 * Push-integrity hashes — the shared window rule for the manifest `head` and
 * the append-time `prefix` (spec §2.3 "Append semantics", D1 offset-resume).
 *
 * The push protocol resumes by byte OFFSET. That is only sound while a
 * transcript is append-only. Codex Desktop 0.153.1 rewrote older rollouts IN
 * PLACE (it added `ordinal` and `payload.session_id` to every line) and left
 * the NTFS mtime at its original value, so the pusher appended the tail of the
 * NEW file onto the OLD prefix and every mirror ended with a torn JSON line at
 * the seam. Both hashes exist to catch that: the same bytes on both sides, or
 * the hub answers `reset`.
 *
 * Both sides import this module, so the window rule cannot drift between them.
 *
 * @module hub/hash
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { log } from '../log.js';

/** Head window for the manifest `head` hash. */
export const HEAD_BYTES = 4096;

/** 64 lowercase hex characters — the wire shape of both hashes. */
export const HEX64_RE = /^[0-9a-f]{64}$/;

/** Read size of one `readSync` while hashing a long prefix. */
const CHUNK_BYTES = 256 * 1024;

/**
 * sha256 of the file's bytes `[0, length)`, or null when the file holds fewer
 * than `length` bytes or cannot be read.
 *
 * Never throws: a hash that cannot be taken means "do not claim anything",
 * and both callers then fall back to the size-only rules. The two null causes
 * are NOT the same, so they are not silent in the same way — a file shorter
 * than `length` is an ordinary answer, while an I/O error is a fault the
 * operator must be able to see, and gets exactly one log line.
 */
export function hashFilePrefix(file: string, length: number): string | null {
  if (!Number.isInteger(length) || length < 0) return null;
  const hash = createHash('sha256');
  if (length === 0) return hash.digest('hex');
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, length));
    let done = 0;
    while (done < length) {
      const want = Math.min(buf.length, length - done);
      const read = readSync(fd, buf, 0, want, done);
      // Shorter than `length`: an ordinary answer, not a fault — no log line.
      if (read <= 0) return null;
      hash.update(buf.subarray(0, read));
      done += read;
    }
    return hash.digest('hex');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    log({
      source: 'hub/hash',
      level: 'warn',
      summary: `hash: could not read ${file}: ${err.code ?? err.message}`,
    });
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** The head window for a file of `size` bytes: `min(size, HEAD_BYTES)`. */
export function headWindow(size: number): number {
  return Math.max(0, Math.min(size, HEAD_BYTES));
}

/** sha256 of `[0, min(size, HEAD_BYTES))` — the manifest `head` value. */
export function hashFileHead(file: string, size: number): string | null {
  return hashFilePrefix(file, headWindow(size));
}
