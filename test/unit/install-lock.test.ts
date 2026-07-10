/**
 * §4.5 robustness — the install lock must never be stolen from a verifiably
 * LIVE owner (the old code overwrote any lock after one hour), and release
 * must verify ownership (PID + token) so a successor's lock is never unlinked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { _setTestRoot, runDir } from '../../src/paths.js';
import { acquireInstallLock, releaseInstallLock } from '../../src/installer/preflight.js';

let recallHome: string;
let restoreRoot: (() => void) | undefined;

function lockPath(): string {
  return join(runDir(), 'install.lock');
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-instlock-${randomUUID()}`);
  mkdirSync(join(recallHome, 'run'), { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreRoot?.();
  rmSync(recallHome, { recursive: true, force: true });
});

describe('install lock ownership', () => {
  it('never steals from a verifiably live owner — even one older than the stale window', () => {
    // A live PID (our own) with an ANCIENT ts: liveness is authoritative.
    writeFileSync(lockPath(), JSON.stringify({
      pid: process.pid, ts: Date.now() - 3 * 60 * 60 * 1000, token: 'someone-elses-token',
    }));
    const r = acquireInstallLock();
    expect(r.ok).toBe(false);
    expect(r.existingPid).toBe(process.pid);
    // The foreign lock is untouched.
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).token).toBe('someone-elses-token');
  });

  it('treats EPERM from the PID probe as a live owner', () => {
    writeFileSync(lockPath(), JSON.stringify({
      pid: 424_242, ts: Date.now() - 3 * 60 * 60 * 1000, token: 'protected-owner-token',
    }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    const r = acquireInstallLock();

    expect(r).toEqual({ ok: false, tookOver: false, existingPid: 424_242 });
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).token).toBe('protected-owner-token');
  });

  it('takes over a dead owner regardless of age', () => {
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 15_000 }).pid!;
    writeFileSync(lockPath(), JSON.stringify({ pid: dead, ts: Date.now(), token: 'dead-token' }));
    const r = acquireInstallLock();
    expect(r.ok).toBe(true);
    expect(r.tookOver).toBe(true);
    releaseInstallLock();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('release verifies PID + token — a successor lock is never unlinked', () => {
    const r = acquireInstallLock();
    expect(r.ok).toBe(true);
    // A successor (crash + reacquire elsewhere) replaced our lock body.
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'successor-token' }));
    releaseInstallLock(); // token mismatch → must NOT unlink
    expect(existsSync(lockPath())).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).token).toBe('successor-token');
  });

  it('an unreadable lock is only taken over once it ages past the stale window', () => {
    writeFileSync(lockPath(), '{corrupt');
    const fresh = acquireInstallLock();
    expect(fresh.ok).toBe(false); // fresh unreadable lock → do not steal
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lockPath(), old, old);
    const aged = acquireInstallLock();
    expect(aged.ok).toBe(true);
    expect(aged.tookOver).toBe(true);
    releaseInstallLock();
  });
});
