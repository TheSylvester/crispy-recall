/**
 * scripts/ci/assert-tarball.mjs — the published-tarball file-set contract.
 *
 * Two silent failure modes this pins:
 *   1. `prepack` strips dist/better_sqlite3.node. If that ever regresses, the
 *      tarball ships a binding compiled for the publisher's Node ABI, which then
 *      refuses to load on the user's — so no entry may end in .node or .wasm.
 *   2. `files: ["dist/", ...]` is a glob: any new build artifact ships silently.
 *      So the entry set is asserted EXACTLY, not as a subset.
 *
 * Synthetic entry lists only — no `npm pack` is run here (CI does that, then
 * calls the same checker on the real tarball). The checker is a plain .mjs so CI
 * can run it with bare node; it is imported through a runtime-built file URL
 * (tsconfig has no allowJs).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(__dirname, '..', '..');

type Check = { ok: boolean; missing: string[]; unexpected: string[]; forbidden: string[]; report: string };
let checkTarballEntries: (entries: string[]) => Check;
let EXPECTED_ENTRIES: string[];

beforeAll(async () => {
  const url = pathToFileURL(join(repoRoot, 'scripts/ci/assert-tarball.mjs')).href;
  const mod = (await import(/* @vite-ignore */ url)) as {
    checkTarballEntries: typeof checkTarballEntries;
    EXPECTED_ENTRIES: string[];
  };
  checkTarballEntries = mod.checkTarballEntries;
  EXPECTED_ENTRIES = mod.EXPECTED_ENTRIES;
});

describe('assert-tarball contract', () => {
  it('accepts exactly the published file set', () => {
    const r = checkTarballEntries([...EXPECTED_ENTRIES]);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.unexpected).toEqual([]);
    expect(r.forbidden).toEqual([]);
  });

  it('tolerates the directory entries `tar -tzf` interleaves', () => {
    const r = checkTarballEntries(['package/', 'package/dist/', ...EXPECTED_ENTRIES]);
    expect(r.ok).toBe(true);
  });

  it('REJECTS a native binding that prepack failed to strip', () => {
    const r = checkTarballEntries([...EXPECTED_ENTRIES, 'package/dist/better_sqlite3.node']);
    expect(r.ok).toBe(false);
    expect(r.forbidden).toEqual(['package/dist/better_sqlite3.node']);
    expect(r.report).toContain('FORBIDDEN');
  });

  it('REJECTS a leftover wasm sidecar', () => {
    const r = checkTarballEntries([...EXPECTED_ENTRIES, 'package/dist/node-sqlite3-wasm.wasm']);
    expect(r.ok).toBe(false);
    expect(r.forbidden).toEqual(['package/dist/node-sqlite3-wasm.wasm']);
  });

  it('REJECTS an unexpected extra artifact (source map, stray fixture)', () => {
    const r = checkTarballEntries([...EXPECTED_ENTRIES, 'package/dist/recall.js.map']);
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(['package/dist/recall.js.map']);
  });

  it('REJECTS a missing required entry', () => {
    const r = checkTarballEntries(EXPECTED_ENTRIES.filter((e) => e !== 'package/dist/SKILL.md.template'));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['package/dist/SKILL.md.template']);
  });

  it('names both bins and the skill template in the contract', () => {
    expect(EXPECTED_ENTRIES).toContain('package/dist/recall.js');
    expect(EXPECTED_ENTRIES).toContain('package/dist/stop-hook.js');
    expect(EXPECTED_ENTRIES).toContain('package/dist/push-pending.js');
    expect(EXPECTED_ENTRIES).toContain('package/dist/SKILL.md.template');
  });
});
