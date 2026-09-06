/**
 * recordEmbedSuccess must not rewrite embed-failure.json for rows that never
 * failed (L8).
 *
 * The old body read the file and rewrote it on EVERY success for as long as a
 * single unrelated failure remained on disk, so a drain of thousands of healthy
 * rows paid a JSON read + write each. Only a success that actually clears state
 * (the id is in `failedMessageIds`, or holds a `retryAfter` cooldown) may write.
 *
 * Isolated via `_setTestRoot` + RECALL_HOME; the live ~/.recall is never opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _setTestRoot, logsDir } from '../../src/paths.js';
import { readEmbedFailure, recordEmbedSuccess } from '../../src/recall/embed-failures.js';

// `vi.spyOn(fs, 'writeFileSync')` is impossible on an ESM builtin namespace, so
// the write is counted by a pass-through module mock instead.
const { writes } = vi.hoisted(() => ({ writes: { count: 0 } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      writes.count += 1;
      return actual.writeFileSync(...args);
    },
  };
});

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let prevHome: string | undefined;

function failureFile(): string { return join(logsDir(), 'embed-failure.json'); }

function seed(value: Record<string, unknown>): void {
  mkdirSync(logsDir(), { recursive: true });
  writeFileSync(failureFile(), JSON.stringify(value));
  writes.count = 0;
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-embed-failure-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  prevHome = process.env['RECALL_HOME'];
  process.env['RECALL_HOME'] = recallHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreRoot?.();
  if (prevHome === undefined) delete process.env['RECALL_HOME'];
  else process.env['RECALL_HOME'] = prevHome;
  rmSync(recallHome, { recursive: true, force: true });
});

describe('recordEmbedSuccess write churn', () => {
  it('is isolated: the failure file sits inside the temp root', () => {
    expect(failureFile().startsWith(recallHome)).toBe(true);
  });

  it('writes nothing for successes on ids that never failed', () => {
    seed({
      updatedAt: new Date().toISOString(), attempts: 1, reason: 'backend down',
      failedMessageIds: ['msg-broken'], retryAfter: {},
    });
    for (const id of ['msg-a', 'msg-b', 'msg-c']) recordEmbedSuccess(id);

    expect(writes.count).toBe(0);
    expect(readEmbedFailure()?.failedMessageIds).toEqual(['msg-broken']);
  });

  it('still clears the id that DID fail', () => {
    seed({
      updatedAt: new Date().toISOString(), attempts: 1, reason: 'backend down',
      failedMessageIds: ['msg-broken', 'msg-other'], retryAfter: { 'msg-broken': Date.now() + 60_000 },
    });
    recordEmbedSuccess('msg-broken');

    expect(writes.count).toBe(1);
    const after = readEmbedFailure();
    expect(after?.failedMessageIds).toEqual(['msg-other']);
    expect(after?.retryAfter).toEqual({});
  });

  it('removes the file when the last failed id succeeds', () => {
    seed({
      updatedAt: new Date().toISOString(), attempts: 1, reason: 'backend down',
      failedMessageIds: ['msg-broken'], retryAfter: {},
    });

    recordEmbedSuccess('msg-broken');

    expect(existsSync(failureFile())).toBe(false);
  });

  it('clears a retryAfter cooldown even once the id left failedMessageIds', () => {
    seed({
      updatedAt: new Date().toISOString(), attempts: 3, reason: 'backend down',
      failedMessageIds: ['msg-other'], retryAfter: { 'msg-cooling': Date.now() + 60_000 },
    });

    recordEmbedSuccess('msg-cooling');

    expect(readEmbedFailure()?.retryAfter).toEqual({});
  });
});
