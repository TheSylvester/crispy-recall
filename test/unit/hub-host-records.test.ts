/**
 * `run/hub-hosts.json` — the per-host activity record (spec §2.1), and the
 * refusal fields both doctors quote (D5).
 *
 * In-process: `_setTestRoot(<tmp>/.recall)` first, restored in `afterAll`;
 * without it `runDir()` resolves to the owner's LIVE `~/.recall`
 * (paths.ts:33-40).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _setTestRoot, runDir } from '../../src/paths.js';
import {
  REFUSED_RECENT_MAX, clearHostRefusals, hubHostsPath, pushRefusedRecent, readHostRecords, updateHostRecord,
} from '../../src/hub/runtime.js';

let sandbox: string;
let restore: () => void;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-host-records-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  expect(resolve(runDir()).startsWith(resolve(tmpdir()))).toBe(true);
});

afterAll(() => {
  restore?.();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(runDir(), { recursive: true });
  writeFileSync(hubHostsPath(), '{}\n');
});

/** Record a refusal exactly as `server.ts` does. */
function refuse(host: string, sid: string): void {
  updateHostRecord(host, (r) => ({
    ...r,
    refusedCollisions: r.refusedCollisions + 1,
    refusedRecent: pushRefusedRecent(r.refusedRecent, sid),
  }));
}

describe('pushRefusedRecent', () => {
  it('is newest first, deduped, and capped', () => {
    expect(pushRefusedRecent([], 'a')).toEqual(['a']);
    expect(pushRefusedRecent(['a'], 'b')).toEqual(['b', 'a']);
    // A repeat moves to the front rather than appearing twice.
    expect(pushRefusedRecent(['b', 'a'], 'a')).toEqual(['a', 'b']);
    let list: string[] = [];
    for (let i = 0; i < 9; i++) list = pushRefusedRecent(list, `sid-${i}`);
    expect(list).toHaveLength(REFUSED_RECENT_MAX);
    expect(list[0]).toBe('sid-8');
    expect(list).not.toContain('sid-3');
  });
});

describe('readHostRecords', () => {
  it('defaults both refusal fields and drops non-string ids', () => {
    writeFileSync(hubHostsPath(), JSON.stringify({
      old: { lastPushAt: 'x' },
      mixed: { refusedCollisions: 2, refusedRecent: ['a', 7, null, 'b'] },
      wrong: { refusedRecent: 'not-an-array' },
    }));
    const r = readHostRecords();
    expect(r['old']).toEqual({ lastPushAt: 'x', refusedCollisions: 0, refusedRecent: [] });
    expect(r['mixed']!.refusedRecent).toEqual(['a', 'b']);
    expect(r['wrong']!.refusedRecent).toEqual([]);
  });
});

describe('clearHostRefusals', () => {
  it('zeroes the count and the ids for that host only, and persists', () => {
    refuse('sat1', 'sid-1');
    refuse('sat1', 'sid-2');
    refuse('sat2', 'sid-3');
    expect(readHostRecords()['sat1']).toMatchObject({ refusedCollisions: 2, refusedRecent: ['sid-2', 'sid-1'] });

    clearHostRefusals('sat1');

    const after = readHostRecords();
    expect(after['sat1']).toMatchObject({ refusedCollisions: 0, refusedRecent: [] });
    // The other host is untouched — clearing is per host, never global.
    expect(after['sat2']).toMatchObject({ refusedCollisions: 1, refusedRecent: ['sid-3'] });
    // On disk, not only in memory.
    const onDisk = JSON.parse(readFileSync(hubHostsPath(), 'utf-8')) as Record<string, { refusedCollisions: number }>;
    expect(onDisk['sat1']!.refusedCollisions).toBe(0);
  });

  it('keeps the rest of the record and is safe on an unknown host', () => {
    updateHostRecord('sat3', (r) => ({ ...r, lastPushAt: '2026-09-05T00:00:00.000Z', refusedCollisions: 4, refusedRecent: ['z'] }));
    clearHostRefusals('sat3');
    expect(readHostRecords()['sat3']).toEqual({
      lastPushAt: '2026-09-05T00:00:00.000Z', refusedCollisions: 0, refusedRecent: [],
    });

    clearHostRefusals('never-seen');
    expect(readHostRecords()['never-seen']).toEqual({ refusedCollisions: 0, refusedRecent: [] });
  });
});
