#!/usr/bin/env node
/**
 * Static coverage check for better-sqlite3 darwin prebuilds vs recall's `engines`.
 *
 * Defect 3 (Node-23 prebuild hole): package.json `engines.node` is `>=22.16`,
 * which PERMITS Node 23 (ABI 131), but better-sqlite3 ships darwin prebuilds only
 * for ABIs 127/137/141/147 (Node 22/24/25/26). So `npm install -g` under Node 23
 * on a Mac without Xcode CLT falls into a node-gyp compile that fails.
 *
 * This script reads the resolved better-sqlite3 release asset names (passed as a
 * file, one per line — produced by `gh api .../releases/tags/vX --jq
 * '.assets[].name'`), maps recall's engines to the Node majors it allows, and
 * reports which allowed majors have NO darwin prebuild.
 *
 * PRE-FIX BASELINE: the gap set is expected to be exactly {23}. This job stays
 * GREEN while asserting the gap exists (and that the majors smoke-local runs on,
 * 22 and 24, ARE covered). phase-2 fixes the defect (narrow engines to exclude 23
 * or wait for a 131 prebuild) and then flips the two baseline expectations below.
 *
 * Usage: node prebuild-coverage.mjs <assets.txt> >> $GITHUB_STEP_SUMMARY
 */
import { readFileSync } from 'node:fs';

// Node major -> NODE_MODULE_VERSION (ABI). Extend when a new LTS lands.
const ABI = { 22: 127, 23: 131, 24: 137, 25: 141, 26: 147 };

const assetsFile = process.argv[2];
if (!assetsFile) {
  console.error('prebuild-coverage: pass the assets list file');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const engines = String(pkg.engines?.node ?? '>=22');
// Floor major from an engines string like ">=22.16".
const minMajor = parseInt((engines.match(/(\d+)/) || ['22'])[0], 10);

let bsqlVersion = 'unknown';
try {
  const lock = JSON.parse(readFileSync('./package-lock.json', 'utf-8'));
  bsqlVersion = lock.packages?.['node_modules/better-sqlite3']?.version ?? bsqlVersion;
} catch { /* informational only */ }

const assets = readFileSync(assetsFile, 'utf-8').split('\n').filter(Boolean);
const darwinAbis = new Set();
for (const a of assets) {
  const m = a.match(/node-v(\d+)-darwin/);
  if (m) darwinAbis.add(Number(m[1]));
}

const allowed = Object.keys(ABI).map(Number).filter((maj) => maj >= minMajor);
const gaps = allowed.filter((maj) => !darwinAbis.has(ABI[maj]));

// --- report (also to the step summary) ---
const lines = [];
lines.push(`## prebuild-coverage-static — better-sqlite3 v${bsqlVersion}`);
lines.push('');
lines.push(`engines.node = \`${engines}\` → allowed majors: ${allowed.join(', ')}`);
lines.push('');
lines.push('| Node major | ABI | darwin prebuild |');
lines.push('| --- | --- | --- |');
for (const maj of allowed) {
  lines.push(`| ${maj} | ${ABI[maj]} | ${darwinAbis.has(ABI[maj]) ? '✅ present' : '❌ MISSING'} |`);
}
lines.push('');
lines.push(gaps.length ? `**Coverage gaps:** ${gaps.map((m) => `Node ${m} (ABI ${ABI[m]})`).join(', ')}` : '**No coverage gaps.**');
const report = lines.join('\n') + '\n';
process.stdout.write(report);

// --- baseline assertions ---
const problems = [];

// Hard: smoke-local runs on Node 22 and 24 — those MUST be covered.
for (const maj of [22, 24]) {
  if (allowed.includes(maj) && gaps.includes(maj)) {
    problems.push(`Node ${maj} (ABI ${ABI[maj]}) is a smoke-local target but has NO darwin prebuild`);
  }
}

// PRE-FIX BASELINE: Node 23 is expected to be a gap. When phase-2 fixes defect 3
// this assertion trips — that is the signal to flip the baseline, not a flake.
if (allowed.includes(23) && !gaps.includes(23)) {
  problems.push(
    'Node 23 (ABI 131) now HAS a darwin prebuild (or engines no longer permits 23) — ' +
    'defect 3 appears fixed. Flip this PRE-FIX baseline in prebuild-coverage.mjs.',
  );
} else if (allowed.includes(23)) {
  console.error('PRE-FIX BASELINE confirmed: engines permits Node 23 (ABI 131) but no darwin prebuild exists (defect 3).');
}

if (problems.length) {
  console.error('PREBUILD COVERAGE FAIL:');
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}

console.log('prebuild-coverage OK (pre-fix baseline holds: gap == Node 23; smoke-local targets 22 & 24 covered).');
