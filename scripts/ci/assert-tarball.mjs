#!/usr/bin/env node
/**
 * Assert the published npm tarball contains EXACTLY the intended file set.
 *
 * WHY: two independent ways the tarball can go wrong, both silent.
 *   1. `prepack` strips `dist/better_sqlite3.node` so the published package does
 *      not carry a host-ABI native binding. If that strip ever regresses, users
 *      get a binding compiled for the publisher's Node, which then fails to load
 *      on theirs. So: NO entry may end in `.node` (or `.wasm`, a leftover from
 *      the node-sqlite3-wasm era).
 *   2. `files` in package.json is a coarse `dist/` glob. A new build artifact —
 *      a source map, a stray fixture, a debug bundle — lands in the tarball
 *      without anyone noticing. So the set is asserted EXACTLY, not as a subset.
 *
 * Usage: node scripts/ci/assert-tarball.mjs <path/to/crispy-recall-x.y.z.tgz>
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Every entry the published tarball must contain, and nothing else. */
export const EXPECTED_ENTRIES = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/THIRD-PARTY-LICENSES',
  'package/dist/recall.js',
  'package/dist/stop-hook.js',
  'package/dist/embed-pending.js',
  'package/dist/statusline.js',
  'package/dist/push-pending.js',
  'package/dist/SKILL.md.template',
];

/** Extensions that must never ship: host-ABI native bindings / wasm sidecars. */
export const FORBIDDEN_EXTENSIONS = ['.node', '.wasm'];

/**
 * Check a tarball entry list against the contract.
 *
 * @param {string[]} entries  `tar -tzf` output lines
 * @returns {{ok: boolean, missing: string[], unexpected: string[], forbidden: string[], report: string}}
 */
export function checkTarballEntries(entries) {
  // `tar -tzf` lists directories with a trailing slash; ignore those, the file
  // entries carry the same information.
  const files = [...new Set(entries.map((e) => String(e).trim()).filter((e) => e && !e.endsWith('/')))].sort();

  const expected = new Set(EXPECTED_ENTRIES);
  const missing = EXPECTED_ENTRIES.filter((e) => !files.includes(e));
  const unexpected = files.filter((f) => !expected.has(f));
  const forbidden = files.filter((f) => FORBIDDEN_EXTENSIONS.some((ext) => f.endsWith(ext)));

  const lines = [];
  lines.push(`tarball entries: ${files.length} (expected ${EXPECTED_ENTRIES.length})`);
  for (const f of files) lines.push(`  ${expected.has(f) ? '✓' : '✗'} ${f}`);
  if (missing.length) {
    lines.push('MISSING (expected but not in the tarball):');
    for (const m of missing) lines.push(`  - ${m}`);
  }
  if (unexpected.length) {
    lines.push('UNEXPECTED (in the tarball but not in the contract):');
    for (const u of unexpected) lines.push(`  + ${u}`);
  }
  if (forbidden.length) {
    lines.push(`FORBIDDEN (${FORBIDDEN_EXTENSIONS.join('/')} must never ship — prepack must strip them):`);
    for (const f of forbidden) lines.push(`  ! ${f}`);
  }

  const ok = missing.length === 0 && unexpected.length === 0 && forbidden.length === 0;
  if (ok) lines.push('assert-tarball OK — exact file set, no native/wasm sidecar.');

  return { ok, missing, unexpected, forbidden, report: lines.join('\n') + '\n' };
}

/** List a .tgz's entries with the system tar (present on ubuntu and macos runners). */
export function listTarball(tgzPath) {
  return execFileSync('tar', ['-tzf', tgzPath], { encoding: 'utf-8' }).split('\n').filter(Boolean);
}

function main(argv) {
  const tgz = argv[2];
  if (!tgz) {
    console.error('assert-tarball: pass the .tgz path');
    return 2;
  }
  let entries;
  try {
    entries = listTarball(tgz);
  } catch (err) {
    console.error(`assert-tarball: could not read ${tgz}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { ok, report } = checkTarballEntries(entries);
  process.stdout.write(report);
  if (!ok) {
    console.error(`::error::tarball contract violated for ${tgz}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
