/**
 * Unit tests for the query-embed coordinator protocol (in-process).
 *
 * The embedder is mocked (embedBatchOneShot records calls and returns
 * deterministic vectors), so these tests exercise the filesystem protocol —
 * request/response lifecycle, dedup, identity isolation, corrupt-artifact
 * handling, stale-lock reaping — without spawning any subprocess. The real
 * cross-process behavior (fleets of built CLIs against a fake llama backend)
 * lives in test/integration/query-coordinator.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

vi.mock('../../src/recall/embedder.js', async () => {
  const actual = await vi.importActual('../../src/recall/embedder.js');
  return {
    ...actual,
    embedBatchOneShot: vi.fn(async (texts: string[]) =>
      texts.map((t) => {
        const v = new Float32Array(768);
        v[0] = t.length; // deterministic, text-dependent
        return v;
      })),
  };
});

import { embedBatchOneShot } from '../../src/recall/embedder.js';
import { coordinatedQueryEmbed, embedIdentity } from '../../src/recall/query-embed-coordinator.js';
import { _setTestRoot, runDir } from '../../src/paths.js';

const mockEmbed = vi.mocked(embedBatchOneShot);

let recallHome: string;
let restoreRoot: (() => void) | undefined;

function qeDir(): string {
  return join(runDir(), 'query-embed');
}

/** A PID that is guaranteed dead: spawn a no-op child and wait for it. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { timeout: 15_000 });
  return r.pid!;
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-qe-unit-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  mockEmbed.mockClear();
});

afterEach(() => {
  restoreRoot?.();
  rmSync(recallHome, { recursive: true, force: true });
});

describe('coordinatedQueryEmbed (in-process protocol)', () => {
  it('single caller: leads, embeds its own text, cleans up all artifacts', async () => {
    const v = await coordinatedQueryEmbed('hello world');
    expect(v).toHaveLength(768);
    expect(v[0]).toBe('hello world'.length);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    // Clean exit → no lock, no request, no response artifacts.
    const leftovers = readdirSync(qeDir());
    expect(leftovers).toEqual([]);
  }, 30_000);

  it('concurrent same-process callers coalesce and duplicates are deduplicated', async () => {
    const [a, b, c] = await Promise.all([
      coordinatedQueryEmbed('same text'),
      coordinatedQueryEmbed('same text'),
      coordinatedQueryEmbed('other text!'),
    ]);
    expect(a[0]).toBe('same text'.length);
    expect(b[0]).toBe('same text'.length);
    expect(c[0]).toBe('other text!'.length);
    // All texts across all calls, flattened: 'same text' must appear only once
    // per batch (exact-text dedup).
    for (const call of mockEmbed.mock.calls) {
      const texts = call[0] as string[];
      expect(new Set(texts).size).toBe(texts.length);
    }
    expect(readdirSync(qeDir())).toEqual([]);
  }, 30_000);

  it('requests with a different embedding identity are never co-batched', async () => {
    const dir = qeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A live-owner foreign-identity request sits in the dir.
    const foreign = join(dir, 'req-foreignid1234567.json');
    writeFileSync(foreign, JSON.stringify({
      v: 1, token: 'foreignid1234567', pid: process.pid,
      identity: 'not-our-identity', text: 'foreign text', createdAt: Date.now(),
    }));

    await coordinatedQueryEmbed('our text');

    // Our batch must not contain the foreign text, and the foreign request
    // must survive untouched for its own (different-identity) leader.
    for (const call of mockEmbed.mock.calls) {
      expect(call[0] as string[]).not.toContain('foreign text');
    }
    expect(existsSync(foreign)).toBe(true);
  }, 30_000);

  it('a corrupt aged request artifact is swept and does not break coordination', async () => {
    const dir = qeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const corrupt = join(dir, 'req-corruptcorrupt12.json');
    writeFileSync(corrupt, '{not json at all');
    const old = new Date(Date.now() - 60_000);
    utimesSync(corrupt, old, old);

    const v = await coordinatedQueryEmbed('healthy text');
    expect(v[0]).toBe('healthy text'.length);
    expect(existsSync(corrupt)).toBe(false);
  }, 30_000);

  it('a stale leader lock (dead PID) is reaped and coordination proceeds', async () => {
    const dir = qeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'leader.lock'), JSON.stringify({
      v: 1, pid: deadPid(), token: 'deadtoken', acquiredAt: Date.now(),
    }));

    const v = await coordinatedQueryEmbed('post-reap text');
    expect(v[0]).toBe('post-reap text'.length);
    expect(readdirSync(qeDir())).toEqual([]); // lock reaped and released
  }, 30_000);

  it('a live foreign leader lock is NOT stolen (waits, then times out → throws)', async () => {
    const dir = qeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A lock owned by a live foreign process — spawn a sleeper to own it.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'leader.lock'), JSON.stringify({
      v: 1, pid: child.pid, token: 'livetoken', acquiredAt: Date.now(),
    }));
    process.env['RECALL_QE_RESPONSE_TIMEOUT_MS'] = '600';
    try {
      await expect(coordinatedQueryEmbed('blocked text')).rejects.toThrow(/timed out/);
      expect(mockEmbed).not.toHaveBeenCalled(); // never fell back to direct embedding
    } finally {
      delete process.env['RECALL_QE_RESPONSE_TIMEOUT_MS'];
      child.kill('SIGKILL');
    }
  }, 30_000);

  it('embed failure propagates as a throw (FTS-only degradation), not a retry storm', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('model exploded'));
    await expect(coordinatedQueryEmbed('doomed text')).rejects.toThrow(/model exploded/);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(readdirSync(qeDir())).toEqual([]);
  }, 30_000);

  it('embedIdentity is stable per config and 16 hex chars', () => {
    const a = embedIdentity();
    const b = embedIdentity();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
