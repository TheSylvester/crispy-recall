/**
 * `peekCwd` window growth (M2c).
 *
 * The cwd peek is what supplies BOTH `cwd` and `key` on every push
 * (`push.ts` derives the key from the peeked cwd). A fixed 64 KiB window meant
 * one oversized first entry — a pasted file, a large image block — produced no
 * complete line at all, the push shipped bare meta, and the hub stored the
 * session with a NULL `project_key`, reachable only through `--all`.
 *
 * `_setTestRoot` does not cross a process boundary, but nothing here spawns:
 * the root is still redirected so an accidental `recallRoot()` read inside the
 * imported module can never resolve to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _setTestRoot, recallRoot } from '../../src/paths.js';
import { CWD_PEEK_BYTES, CWD_PEEK_LINES, CWD_PEEK_MAX_BYTES, peekCwd } from '../../src/satellite/push.js';

let sandbox: string;
let restore: (() => void) | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-peek-cwd-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
});

afterAll(() => {
  restore?.();
  rmSync(sandbox, { recursive: true, force: true });
});

/** A Claude entry whose `text` is padded to make the serialized line ≥ `bytes`. */
function fatEntry(bytes: number, cwd?: string): string {
  const base = { type: 'user', uuid: 'fat', sessionId: 's', ...(cwd ? { cwd } : {}), message: { role: 'user', content: '' } };
  const overhead = JSON.stringify(base).length;
  base.message.content = 'x'.repeat(Math.max(0, bytes - overhead));
  return JSON.stringify(base) + '\n';
}

function write(name: string, body: string): string {
  const p = join(sandbox, name);
  writeFileSync(p, body);
  return p;
}

describe('peekCwd', () => {
  it('sandbox guard: recallRoot() sits under tmpdir', () => {
    expect(resolve(recallRoot()).startsWith(resolve(tmpdir()))).toBe(true);
  });

  it('finds the cwd on the first line of an ordinary transcript', () => {
    const f = write('plain.jsonl', JSON.stringify({ type: 'user', cwd: '/home/u/proj', message: {} }) + '\n');
    expect(peekCwd(f)).toBe('/home/u/proj');
  });

  it('reads the Codex `payload.cwd`', () => {
    const f = write('codex.jsonl', JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/home/u/rollout' } }) + '\n');
    expect(peekCwd(f)).toBe('/home/u/rollout');
  });

  it('grows past a first line LARGER than the 64 KiB window and finds the cwd on the next one', () => {
    const fat = fatEntry(CWD_PEEK_BYTES + 4096);
    expect(fat.length).toBeGreaterThan(CWD_PEEK_BYTES);
    const f = write('fat-head.jsonl', fat + JSON.stringify({ type: 'user', cwd: '/home/u/behind-the-fat-line', message: {} }) + '\n');
    expect(peekCwd(f)).toBe('/home/u/behind-the-fat-line');
  });

  it('finds the cwd ON the oversized line itself', () => {
    const f = write('fat-carrier.jsonl', fatEntry(CWD_PEEK_BYTES + 4096, '/home/u/on-the-fat-line'));
    expect(peekCwd(f)).toBe('/home/u/on-the-fat-line');
  });

  it('gives up at the 1 MiB ceiling rather than reading an arbitrarily large head', () => {
    // One line past the cap, so no complete line can ever be produced.
    const f = write('over-cap.jsonl', fatEntry(CWD_PEEK_MAX_BYTES + 8192, '/home/u/unreachable'));
    expect(peekCwd(f)).toBeUndefined();
  });

  it('still stops at CWD_PEEK_LINES complete lines: a cwd beyond them is not found', () => {
    const filler = Array.from({ length: CWD_PEEK_LINES }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, message: {} })).join('\n') + '\n';
    const f = write('deep.jsonl', filler + JSON.stringify({ type: 'user', cwd: '/home/u/too-deep', message: {} }) + '\n');
    expect(peekCwd(f)).toBeUndefined();
  });

  it('returns undefined for a missing file and for a file with no cwd anywhere', () => {
    expect(peekCwd(join(sandbox, 'nope.jsonl'))).toBeUndefined();
    expect(peekCwd(write('empty.jsonl', ''))).toBeUndefined();
    expect(peekCwd(write('nocwd.jsonl', JSON.stringify({ type: 'user', message: {} }) + '\n'))).toBeUndefined();
  });
});
