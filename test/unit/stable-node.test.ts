/**
 * stableNodePath — defect 2 (upgrade-stable node pin).
 *
 * process.execPath resolves to the versioned Homebrew Cellar path, which
 * `brew upgrade node && brew cleanup` deletes — bricking every recall command
 * pinned to it. stableNodePath prefers a public shim (/opt/homebrew/bin/node)
 * that resolves to the SAME binary, and is a strict no-op when no such shim
 * exists (nvm, Windows, bespoke layouts). Simulated here with a temp
 * Cellar-plus-shim symlink layout so it runs on any host.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stableNodePath } from '../../src/installer/stable-node.js';

let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = undefined; }
});

/** Build a Cellar real binary + a public shim symlink pointing at it. */
function layout() {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-stable-node-'));
  const cellar = join(sandbox, 'Cellar', 'node', '24.4.0', 'bin');
  const shimDir = join(sandbox, 'bin');
  mkdirSync(cellar, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  const realNode = join(cellar, 'node');
  writeFileSync(realNode, '#!/bin/sh\n');
  const shim = join(shimDir, 'node');
  symlinkSync(realNode, shim);
  return { realNode, shim };
}

describe('stableNodePath', () => {
  it('prefers a shim that resolves to the same binary as execPath', () => {
    const { realNode, shim } = layout();
    // execPath = the resolved Cellar path (what Node reports); shim → same file.
    expect(stableNodePath({ execPath: realNode, candidates: [shim] })).toBe(shim);
  });

  it('resolves through a symlinked execPath too (nvm-style) to the same binary', () => {
    const { realNode, shim } = layout();
    const nvmLink = join(sandbox!, 'nvm-node');
    symlinkSync(realNode, nvmLink);
    expect(stableNodePath({ execPath: nvmLink, candidates: [shim] })).toBe(shim);
  });

  it('falls through to execPath when a shim points at a DIFFERENT binary', () => {
    const { shim } = layout();
    const otherNode = join(sandbox!, 'other-node');
    writeFileSync(otherNode, '#!/bin/sh\n');
    // shim resolves to the Cellar node, not otherNode → no match.
    expect(stableNodePath({ execPath: otherNode, candidates: [shim] })).toBe(otherNode);
  });

  it('falls through to execPath when no candidate exists', () => {
    const { realNode } = layout();
    expect(stableNodePath({ execPath: realNode, candidates: [join(sandbox!, 'nope')] })).toBe(realNode);
  });

  it('treats a dangling candidate symlink as a non-match', () => {
    const { realNode } = layout();
    const dangling = join(sandbox!, 'dangling');
    symlinkSync(join(sandbox!, 'missing-target'), dangling);
    expect(stableNodePath({ execPath: realNode, candidates: [dangling] })).toBe(realNode);
  });

  it('returns execPath unchanged when it cannot be resolved', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'recall-stable-node-'));
    const missing = join(sandbox, 'missing-exec');
    expect(stableNodePath({ execPath: missing, candidates: [] })).toBe(missing);
  });

  it('defaults to process.execPath off Homebrew (no matching shim on this host)', () => {
    // On the dev box (nvm) none of the default Homebrew shims match → no-op.
    expect(stableNodePath()).toBe(process.execPath);
  });
});
