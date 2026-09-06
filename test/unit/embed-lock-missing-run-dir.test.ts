/**
 * embed-lock on a root with no `run/` directory (M1 / tracker R-k73qa4).
 *
 * `writeFileSync(embedLockPath(), pid, { flag: 'wx' })` throws ENOENT when
 * `~/.recall/run/` does not exist, the catch's `readFileSync` throws too, and
 * both loop passes `continue` into a bare `return false` — indistinguishable
 * from "another process holds the lock". `repair --full` (repair.ts →
 * runEmbeddingBackfill) and a non-detached `recall backfill --auto-embed` both
 * reach `tryAcquireEmbedLock` with no prior mkdir, so on a freshly restored
 * snapshot root every re-embed was silently skipped.
 *
 * Isolated via `_setTestRoot` + RECALL_HOME; the live ~/.recall is never opened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _setTestRoot, runDir } from '../../src/paths.js';
import { embedLockPath, releaseEmbedLock, tryAcquireEmbedLock } from '../../src/recall/embed-lock.js';

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-embed-lock-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  prevHome = process.env['RECALL_HOME'];
  process.env['RECALL_HOME'] = recallHome;
});

afterEach(() => {
  restoreRoot?.();
  if (prevHome === undefined) delete process.env['RECALL_HOME'];
  else process.env['RECALL_HOME'] = prevHome;
  rmSync(recallHome, { recursive: true, force: true });
});

describe('tryAcquireEmbedLock on a root with no run/ directory', () => {
  it('is isolated: the lock path sits inside the temp root', () => {
    expect(embedLockPath().startsWith(recallHome)).toBe(true);
  });

  it('creates run/ and acquires the lock instead of reporting it held', () => {
    expect(existsSync(runDir())).toBe(false);

    expect(tryAcquireEmbedLock()).toBe(true);
    expect(existsSync(embedLockPath())).toBe(true);
    expect(readFileSync(embedLockPath(), 'utf8')).toBe(String(process.pid));

    releaseEmbedLock();
    expect(existsSync(embedLockPath())).toBe(false);
  });

  it('still reports a live foreign holder as held', () => {
    mkdirSync(runDir(), { recursive: true });
    // A live PID that is not ours: the parent process always qualifies.
    const foreign = process.ppid && process.ppid !== process.pid ? process.ppid : 1;
    writeFileSync(embedLockPath(), String(foreign));

    expect(tryAcquireEmbedLock()).toBe(false);
    // …and releasing someone else's lock is a no-op.
    releaseEmbedLock();
    expect(existsSync(embedLockPath())).toBe(true);
  });
});
