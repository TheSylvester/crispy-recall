/**
 * scripts/ci/prebuild-coverage.mjs — the engines-vs-prebuilds gate.
 *
 * better-sqlite3 publishes Node prebuilds only for a few ABIs. If package.json
 * `engines` admits a Node major with no prebuild, `npm install -g` drops into a
 * node-gyp compile that fails on any machine without a C++ toolchain. This suite
 * pins the guard's contract against the REAL v12.11.1 asset list (40 `node-v*`
 * assets, ABIs 127/137/141/147 only — no 115/120/131):
 *
 *   - the shipped engines string is green, with Node 20 reported satellite-only
 *     (no prebuild, source build accepted) rather than failed;
 *   - re-admitting Node 21 or Node 23 goes RED and names the major;
 *   - a hub major losing any of darwin/linux/win32 goes RED.
 *
 * The guard is a plain .mjs so CI can run it with bare node; it is imported here
 * through a runtime-built file URL (tsconfig has no allowJs).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(__dirname, '..', '..');

type Coverage = {
  allowed: number[];
  hub: number[];
  satelliteOnly: number[];
  future: number[];
  gaps: { major: number; abi: number; missing: string[] }[];
  problems: string[];
  report: string;
};
let evaluateCoverage: (engines: string, assets: string[], opts?: { bsqlVersion?: string }) => Coverage;

beforeAll(async () => {
  const url = pathToFileURL(join(repoRoot, 'scripts/ci/prebuild-coverage.mjs')).href;
  const mod = (await import(/* @vite-ignore */ url)) as { evaluateCoverage: typeof evaluateCoverage };
  evaluateCoverage = mod.evaluateCoverage;
});

/** The shipped engines range — read from package.json so the two cannot drift. */
const SHIPPED_ENGINES = String(
  (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { engines?: { node?: string } }).engines?.node,
);

/**
 * The real better-sqlite3 v12.11.1 `node-v*` release assets (fetched from
 * https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1). Only ABIs
 * 127 (Node 22), 137 (Node 24), 141 (Node 25) and 147 (Node 26) exist; there is
 * no 115 (Node 20), 120 (Node 21) or 131 (Node 23). The electron-* assets of the
 * same release are irrelevant to a Node runtime and are omitted.
 */
const ASSETS_12_11_1 = [
  'better-sqlite3-v12.11.1-node-v127-darwin-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-darwin-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-linux-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-linux-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-linux-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-linuxmusl-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-linuxmusl-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-linuxmusl-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-win32-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v127-win32-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-darwin-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-darwin-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-linux-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-linux-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-linuxmusl-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-linuxmusl-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-linuxmusl-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-win32-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-darwin-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-darwin-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-linux-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-linux-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-linux-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-linuxmusl-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-linuxmusl-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-linuxmusl-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-win32-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v141-win32-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-darwin-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-darwin-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-linux-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-linux-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-linux-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-linuxmusl-arm.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-linuxmusl-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-linuxmusl-x64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-win32-arm64.tar.gz',
  'better-sqlite3-v12.11.1-node-v147-win32-x64.tar.gz',
];

describe('prebuild-coverage guard', () => {
  it('the shipped engines string is the narrowed one', () => {
    expect(SHIPPED_ENGINES).toBe('>=20.0.0 <21 || >=22.0.0 <23 || >=24.0.0');
  });

  it('passes on the shipped engines + the real v12.11.1 assets, with Node 20 satellite-only', () => {
    const r = evaluateCoverage(SHIPPED_ENGINES, ASSETS_12_11_1, { bsqlVersion: '12.11.1' });
    expect(r.problems).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.satelliteOnly).toEqual([20]);
    expect(r.hub).toEqual([22, 24, 25, 26]);
    expect(r.allowed).toContain(20);
    expect(r.allowed).not.toContain(21);
    expect(r.allowed).not.toContain(23);
    expect(r.report).toContain('no prebuild — source build (python3, make, C++ compiler) required on a satellite');
  });

  it('FAILs when engines is widened to re-admit Node 21', () => {
    // The pre-fix range: `<23` silently let Node 21 (ABI 120, no prebuild) back in.
    const r = evaluateCoverage('>=20.0.0 <23 || >=24.0.0', ASSETS_12_11_1);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.join('\n')).toContain('Node 21');
    expect(r.allowed).toContain(21);
  });

  it('FAILs when engines admits Node 23', () => {
    const r = evaluateCoverage('>=22.0.0', ASSETS_12_11_1);
    expect(r.problems.join('\n')).toContain('Node 23');
    expect(r.allowed).toContain(23);
  });

  it('FAILs when a hub major loses its linux prebuild', () => {
    const crippled = ASSETS_12_11_1.filter((a) => !a.includes('node-v137-linux-'));
    const r = evaluateCoverage(SHIPPED_ENGINES, crippled);
    expect(r.gaps).toEqual([{ major: 24, abi: 137, missing: ['linux'] }]);
    expect(r.problems.join('\n')).toMatch(/Node 24 \(ABI 137\) is a HUB major but has NO linux prebuild/);
  });

  it('FAILs when engines admits a major the ABI table does not know', () => {
    // Node 19 is inside the table's horizon but has no entry — a silent skip
    // before the fix, a hard failure now.
    const r = evaluateCoverage('>=19.0.0 <20 || >=22.0.0 <23 || >=24.0.0', ASSETS_12_11_1);
    expect(r.problems.join('\n')).toContain('Node 19 is allowed by engines but has no entry in the ABI table');
  });
});
