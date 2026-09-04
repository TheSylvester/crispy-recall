/**
 * remoteRoot() and isUnderRemoteRoot() (spec S2 / §4.2).
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { _setTestRoot, recallRoot, remoteRoot } from '../../src/paths.js';
import { isUnderRemoteRoot } from '../../src/recall/mirror-meta.js';

let sandbox: string;
let restore: (() => void) | undefined;
let prevRemote: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-remoteroot-'));
  prevRemote = process.env['RECALL_REMOTE_ROOT'];
  delete process.env['RECALL_REMOTE_ROOT'];
  restore = _setTestRoot(join(sandbox, '.recall'));
});

afterEach(() => {
  restore?.(); restore = undefined;
  if (prevRemote === undefined) delete process.env['RECALL_REMOTE_ROOT'];
  else process.env['RECALL_REMOTE_ROOT'] = prevRemote;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('remoteRoot', () => {
  it('defaults to <recallRoot>/remote and tracks _setTestRoot', () => {
    expect(remoteRoot()).toBe(join(recallRoot(), 'remote'));
    const second = _setTestRoot(join(sandbox, 'other-root'));
    try {
      expect(remoteRoot()).toBe(join(sandbox, 'other-root', 'remote'));
    } finally { second(); }
  });

  it('returns RECALL_REMOTE_ROOT verbatim, with no trailing separator', () => {
    const custom = join(sandbox, 'elsewhere', 'mirror');
    process.env['RECALL_REMOTE_ROOT'] = custom;
    expect(remoteRoot()).toBe(custom);
    expect(remoteRoot().endsWith(sep)).toBe(false);
  });
});

describe('isUnderRemoteRoot', () => {
  it('is true for a file inside the mirror', () => {
    expect(isUnderRemoteRoot(join(remoteRoot(), 'laptop', 'claude', 'projects', 'a.jsonl'))).toBe(true);
  });

  it('is false for remoteRoot() itself', () => {
    expect(isUnderRemoteRoot(remoteRoot())).toBe(false);
  });

  it('is false for a sibling sharing the string prefix (the `+ sep` guard)', () => {
    expect(isUnderRemoteRoot(join(recallRoot(), 'remote-x', 'a.jsonl'))).toBe(false);
  });
});
