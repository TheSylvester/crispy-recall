/**
 * `hub/hash` — the window rule both sides of the push protocol share (D1).
 *
 * Pure filesystem reads into a temp directory; no recall root is touched, so
 * this suite needs no `_setTestRoot`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HEAD_BYTES, HEX64_RE, hashFileHead, hashFilePrefix, headWindow } from '../../src/hub/hash.js';

let dir: string;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** `<dir>/<name>` holding `body`. */
function file(name: string, body: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'recall-hub-hash-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('headWindow', () => {
  it('is min(size, HEAD_BYTES) and never negative', () => {
    expect(HEAD_BYTES).toBe(4096);
    expect(headWindow(0)).toBe(0);
    expect(headWindow(1)).toBe(1);
    expect(headWindow(HEAD_BYTES - 1)).toBe(HEAD_BYTES - 1);
    expect(headWindow(HEAD_BYTES)).toBe(HEAD_BYTES);
    expect(headWindow(HEAD_BYTES + 1)).toBe(HEAD_BYTES);
    expect(headWindow(-5)).toBe(0);
  });
});

describe('hashFilePrefix', () => {
  it('hashes exactly the first `length` bytes', () => {
    const body = Buffer.from('abcdefghij');
    const p = file('ten.txt', body);
    expect(hashFilePrefix(p, 10)).toBe(sha(body));
    expect(hashFilePrefix(p, 4)).toBe(sha(body.subarray(0, 4)));
    expect(HEX64_RE.test(hashFilePrefix(p, 4)!)).toBe(true);
  });

  it('length 0 is the empty hash — even for a file that does not exist', () => {
    expect(hashFilePrefix(file('empty.txt', ''), 0)).toBe(sha(Buffer.alloc(0)));
    expect(hashFilePrefix(join(dir, 'absent.txt'), 0)).toBe(sha(Buffer.alloc(0)));
  });

  it('returns null when the file is shorter than `length`, is absent, or the length is invalid', () => {
    const p = file('short.txt', 'abc');
    expect(hashFilePrefix(p, 4)).toBeNull();
    expect(hashFilePrefix(join(dir, 'absent2.txt'), 1)).toBeNull();
    expect(hashFilePrefix(p, -1)).toBeNull();
    expect(hashFilePrefix(p, 1.5)).toBeNull();
  });

  it('spans more than one read chunk', () => {
    const body = Buffer.alloc(700 * 1024, 0x61);
    body.write('tail-marker', body.length - 11);
    const p = file('big.txt', body);
    expect(hashFilePrefix(p, body.length)).toBe(sha(body));
  });
});

describe('hashFileHead', () => {
  it('an empty file hashes the empty window', () => {
    const p = file('head-empty.txt', '');
    expect(hashFileHead(p, 0)).toBe(sha(Buffer.alloc(0)));
  });

  it('a file of exactly HEAD_BYTES hashes the whole file', () => {
    const body = Buffer.alloc(HEAD_BYTES, 0x7a);
    const p = file('head-exact.txt', body);
    expect(hashFileHead(p, HEAD_BYTES)).toBe(sha(body));
    expect(hashFileHead(p, HEAD_BYTES)).toBe(hashFilePrefix(p, HEAD_BYTES));
  });

  it('a longer file hashes only its first HEAD_BYTES — the tail cannot move it', () => {
    const head = Buffer.alloc(HEAD_BYTES, 0x7a);
    const one = file('head-long-a.txt', Buffer.concat([head, Buffer.from('AAAA')]));
    const two = file('head-long-b.txt', Buffer.concat([head, Buffer.from('BBBBBBBB')]));
    expect(hashFileHead(one, HEAD_BYTES + 4)).toBe(sha(head));
    expect(hashFileHead(two, HEAD_BYTES + 8)).toBe(hashFileHead(one, HEAD_BYTES + 4));
  });

  it('a byte changed inside the window changes the hash', () => {
    const body = Buffer.alloc(HEAD_BYTES + 100, 0x7a);
    const before = hashFileHead(file('head-flip.txt', body), body.length);
    body[10] = 0x41;
    const after = hashFileHead(file('head-flip.txt', body), body.length);
    expect(after).not.toBe(before);
  });
});
