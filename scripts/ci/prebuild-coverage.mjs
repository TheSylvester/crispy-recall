#!/usr/bin/env node
/**
 * Static coverage check for better-sqlite3 darwin prebuilds vs recall's `engines`.
 *
 * Defect 3 (Node-23 prebuild hole): better-sqlite3 ships darwin prebuilds only
 * for ABIs 127/137/141/147 (Node 22/24/25/26) — there is NO 131 (Node 23), so
 * `npm install -g` under Node 23 on a Mac without Xcode CLT falls into a node-gyp
 * compile that fails. The fix narrows `engines.node` to exclude 23
 * (`>=22.16.0 <23 || >=24.0.0`).
 *
 * This script reads the resolved better-sqlite3 release asset names (passed as a
 * file, one per line — produced by `gh api .../releases/tags/vX --jq
 * '.assets[].name'`), evaluates recall's `engines` range to find the Node majors
 * it actually allows, and asserts EVERY allowed major has a darwin prebuild.
 *
 * GREEN = no engines-allowed major is missing a darwin prebuild (and the majors
 * smoke-local runs on, 22 and 24, ARE covered). It goes RED if `engines` widens
 * to re-admit a major with no prebuild (e.g. Node 23 creeps back in), which is
 * exactly the regression this guards.
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

// --- minimal semver range satisfaction (enough for our engines strings) ---
function cmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
function satisfiesComparator(version, comp) {
  const m = comp.match(/^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
  if (!m) return false;
  const op = m[1] || '=';
  const c = cmp(version, m[2]);
  return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
}
/** A range is `clause || clause`, each clause a space-separated AND of comparators. */
function satisfies(version, range) {
  return range.split('||').some((clause) =>
    clause.trim().split(/\s+/).filter(Boolean).every((comp) => satisfiesComparator(version, comp)),
  );
}
/** A major is allowed if some representative version of it satisfies the range. */
function majorAllowed(maj) {
  return [`${maj}.0.0`, `${maj}.16.0`, `${maj}.99.0`].some((v) => satisfies(v, engines));
}

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

const allowed = Object.keys(ABI).map(Number).filter(majorAllowed);
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
// Show Node 23 explicitly as excluded-by-design (the defect-3 hole is closed).
if (!allowed.includes(23)) {
  lines.push(`| ~~23~~ | ${ABI[23]} | excluded by engines (no darwin prebuild) |`);
}
lines.push('');
lines.push(gaps.length ? `**Coverage gaps:** ${gaps.map((m) => `Node ${m} (ABI ${ABI[m]})`).join(', ')}` : '**No coverage gaps.**');
const report = lines.join('\n') + '\n';
process.stdout.write(report);

// --- assertions (post-fix: every allowed major must have a darwin prebuild) ---
const problems = [];

// Hard: smoke-local runs on Node 22 and 24 — those MUST be allowed AND covered.
for (const maj of [22, 24]) {
  if (!allowed.includes(maj)) {
    problems.push(`Node ${maj} is a smoke-local target but engines no longer allows it`);
  } else if (gaps.includes(maj)) {
    problems.push(`Node ${maj} (ABI ${ABI[maj]}) is a smoke-local target but has NO darwin prebuild`);
  }
}

// Core invariant: no engines-allowed major may lack a darwin prebuild. If Node 23
// (or any other prebuild-less major) is re-admitted to engines, this trips.
for (const maj of gaps) {
  problems.push(`Node ${maj} (ABI ${ABI[maj]}) is allowed by engines but has NO darwin prebuild — narrow engines or wait for a prebuild`);
}

if (problems.length) {
  console.error('PREBUILD COVERAGE FAIL:');
  for (const p of [...new Set(problems)]) console.error(`  ✖ ${p}`);
  process.exit(1);
}

console.log(`prebuild-coverage OK — all engines-allowed majors (${allowed.join(', ')}) have darwin prebuilds; Node 23 excluded by engines.`);
