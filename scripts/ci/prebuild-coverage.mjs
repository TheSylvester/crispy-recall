#!/usr/bin/env node
/**
 * Static coverage check for better-sqlite3 Node prebuilds vs recall's `engines`.
 *
 * WHY: better-sqlite3 publishes Node prebuilds only for a handful of ABIs (for
 * v12.11.1: 127/137/141/147 = Node 22/24/25/26). There is NO prebuild for ABI
 * 115 (Node 20), 120 (Node 21) or 131 (Node 23). A Node major that `engines`
 * admits but that has no prebuild sends `npm install -g` into a node-gyp
 * compile, which fails on any machine without python3/make/a C++ compiler.
 *
 * ROLE-HONEST: recall has two roles with two different floors.
 *   - HUB majors (what `checkNode` in src/installer/preflight.ts accepts: 22,
 *     24, 25, 26) load the native binding. They MUST have darwin AND linux AND
 *     win32 prebuilds — a gap is a hard FAIL.
 *   - SATELLITE_ONLY majors (20) never load the binding. npm still installs the
 *     dependency and compiles it from source, which is a documented, accepted
 *     cost (python3 + make + a C/C++ compiler must be present). Reported, never
 *     a failure.
 *   - Anything else `engines` admits is a FAIL: either it needs prebuilds it
 *     does not have, or nobody decided what role it plays.
 *
 * EXHAUSTIVE: `engines` is probed over Node majors 18..30, so a major that it
 * admits but the table does not know about FAILs loudly instead of being
 * silently skipped (the pre-fix bug: the table started at 22, so admitted majors
 * 20 and 21 were never even considered). The one exception is the open upper
 * end: `>=24.0.0` necessarily admits majors that do not exist yet, so admitted
 * majors ABOVE the highest entry in the ABI table are reported as future work
 * (extend the table when that Node ships) rather than failed. Every admitted
 * major at or below the table's horizon must have an entry.
 *
 * Input is the resolved better-sqlite3 release asset names (one per line,
 * produced by `gh api .../releases/tags/vX --jq '.assets[].name'`).
 *
 * Usage: node prebuild-coverage.mjs <assets.txt> >> $GITHUB_STEP_SUMMARY
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node major -> NODE_MODULE_VERSION (ABI). Extend when a new major lands; an
// engines-admitted major missing from here is a FAIL, never a skip.
export const ABI = { 20: 115, 21: 120, 22: 127, 23: 131, 24: 137, 25: 141, 26: 147 };

/** Majors the HUB accepts (src/installer/preflight.ts checkNode: 22.16+ or 24+). */
export const HUB_MAJORS = [22, 24, 25, 26];

/** Majors supported for SATELLITES only — no prebuild needed, source build is fine. */
export const SATELLITE_ONLY = [20];

/** Platforms a hub major must have a prebuild for. */
export const REQUIRED_PLATFORMS = ['darwin', 'linux', 'win32'];

/** Node majors probed against `engines`. Wide enough to catch anything real. */
const PROBE_MAJORS = Array.from({ length: 13 }, (_, i) => 18 + i); // 18..30

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
export function satisfies(version, range) {
  return range.split('||').some((clause) =>
    clause.trim().split(/\s+/).filter(Boolean).every((comp) => satisfiesComparator(version, comp)),
  );
}
/** A major is allowed if some representative version of it satisfies the range. */
export function majorAllowed(maj, range) {
  return [`${maj}.0.0`, `${maj}.16.0`, `${maj}.99.0`].some((v) => satisfies(v, range));
}

/**
 * Evaluate prebuild coverage.
 *
 * @param {string} enginesString  package.json engines.node
 * @param {string[]} assetNames   better-sqlite3 release asset names
 * @returns {{allowed:number[], hub:number[], satelliteOnly:number[], gaps:object[], problems:string[], report:string}}
 */
export function evaluateCoverage(enginesString, assetNames, opts = {}) {
  const bsqlVersion = opts.bsqlVersion ?? 'unknown';

  // ABI -> Set(platforms) from `...-node-v<ABI>-<platform>-<arch>.tar.gz`.
  const byAbi = new Map();
  for (const a of assetNames) {
    // The trailing `-` is load-bearing: without it `linuxmusl-x64` matches
    // `linux` and a missing glibc linux prebuild would be masked by a musl one.
    const m = String(a).match(/node-v(\d+)-(darwin|linux|win32)-/);
    if (!m) continue; // electron-*, linuxmusl-*, checksums: not our runtime
    const abi = Number(m[1]);
    if (!byAbi.has(abi)) byAbi.set(abi, new Set());
    byAbi.get(abi).add(m[2]);
  }
  const platformsFor = (maj) => [...(byAbi.get(ABI[maj]) ?? new Set())].sort();

  const allowed = PROBE_MAJORS.filter((maj) => majorAllowed(maj, enginesString));
  const problems = [];
  const gaps = [];

  // The ABI table's horizon: the newest major whose ABI we know. `engines` ends
  // in an open `>=24.0.0`, so anything above the horizon is an unreleased major,
  // not a hole in the table.
  const horizon = Math.max(...Object.keys(ABI).map(Number));
  const future = allowed.filter((maj) => maj > horizon);

  // Exhaustiveness: an admitted major at or below the horizon with no ABI entry
  // is a FAIL, never a silent skip.
  const unknown = allowed.filter((maj) => maj <= horizon && ABI[maj] === undefined);
  for (const maj of unknown) {
    problems.push(
      `Node ${maj} is allowed by engines but has no entry in the ABI table — add it (with its NODE_MODULE_VERSION) and decide its role`,
    );
  }

  const known = allowed.filter((maj) => maj <= horizon && ABI[maj] !== undefined);
  const hub = known.filter((maj) => HUB_MAJORS.includes(maj));
  const satelliteOnly = known.filter((maj) => SATELLITE_ONLY.includes(maj) && !HUB_MAJORS.includes(maj));
  const unclassified = known.filter((maj) => !HUB_MAJORS.includes(maj) && !SATELLITE_ONLY.includes(maj));

  for (const maj of hub) {
    const have = platformsFor(maj);
    const missing = REQUIRED_PLATFORMS.filter((p) => !have.includes(p));
    if (missing.length) {
      gaps.push({ major: maj, abi: ABI[maj], missing });
      problems.push(
        `Node ${maj} (ABI ${ABI[maj]}) is a HUB major but has NO ${missing.join('/')} prebuild — narrow engines or wait for a prebuild`,
      );
    }
  }

  for (const maj of unclassified) {
    problems.push(
      `Node ${maj} (ABI ${ABI[maj]}) is allowed by engines but is neither a hub major nor satellite-only — no prebuild guarantee, so exclude it from engines or classify it`,
    );
  }

  // Hard: smoke-local/ci-linux run on Node 22 and 24 — those MUST be allowed and covered.
  for (const maj of [22, 24]) {
    if (!allowed.includes(maj)) {
      problems.push(`Node ${maj} is a CI matrix target but engines no longer allows it`);
    }
  }

  // --- report ---
  const lines = [];
  lines.push(`## prebuild-coverage — better-sqlite3 v${bsqlVersion}`);
  lines.push('');
  lines.push(`engines.node = \`${enginesString}\` → allowed majors: ${allowed.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('| Node major | ABI | role | node prebuilds | verdict |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const maj of allowed) {
    if (maj > horizon) continue; // summarised as "future majors" below
    const abi = ABI[maj];
    if (abi === undefined) {
      lines.push(`| ${maj} | ? | UNKNOWN | ? | ❌ not in the ABI table |`);
      continue;
    }
    const have = platformsFor(maj);
    const role = HUB_MAJORS.includes(maj) ? 'hub' : SATELLITE_ONLY.includes(maj) ? 'satellite-only' : 'UNCLASSIFIED';
    let verdict;
    if (role === 'hub') {
      const missing = REQUIRED_PLATFORMS.filter((p) => !have.includes(p));
      verdict = missing.length ? `❌ MISSING ${missing.join(', ')}` : '✅ darwin + linux + win32';
    } else if (role === 'satellite-only') {
      verdict = have.length
        ? `✅ prebuilt (${have.join(', ')})`
        : 'ℹ️ no prebuild — source build (python3, make, C++ compiler) required on a satellite';
    } else {
      verdict = '❌ unclassified role';
    }
    lines.push(`| ${maj} | ${abi} | ${role} | ${have.join(', ') || '(none)'} | ${verdict} |`);
  }
  for (const maj of [21, 23]) {
    if (!allowed.includes(maj)) {
      lines.push(`| ~~${maj}~~ | ${ABI[maj]} | — | (none) | excluded by engines (no prebuild) |`);
    }
  }
  if (future.length) {
    lines.push(
      `| ${future[0]}+ | ? | future | — | ℹ️ beyond the ABI table horizon (Node ${horizon}) — extend ABI when it ships |`,
    );
  }
  lines.push('');
  lines.push(
    gaps.length
      ? `**Hub coverage gaps:** ${gaps.map((g) => `Node ${g.major} (ABI ${g.abi}) missing ${g.missing.join('/')}`).join('; ')}`
      : '**No hub coverage gaps.**',
  );
  if (satelliteOnly.length) {
    lines.push('');
    lines.push(
      `**Satellite-only majors:** ${satelliteOnly.join(', ')} — no prebuild, so npm compiles better-sqlite3 from source. python3, make and a C/C++ compiler must be present even though a satellite never loads the binding.`,
    );
  }
  const report = lines.join('\n') + '\n';

  return { allowed, hub, satelliteOnly, future, gaps, problems: [...new Set(problems)], report };
}

// --- CLI ---------------------------------------------------------------------
function main(argv) {
  const assetsFile = argv[2];
  if (!assetsFile) {
    console.error('prebuild-coverage: pass the assets list file');
    return 2;
  }

  const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
  const engines = String(pkg.engines?.node ?? '>=22');

  let bsqlVersion = 'unknown';
  try {
    const lock = JSON.parse(readFileSync('./package-lock.json', 'utf-8'));
    bsqlVersion = lock.packages?.['node_modules/better-sqlite3']?.version ?? bsqlVersion;
  } catch { /* informational only */ }

  const assets = readFileSync(assetsFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
  const { allowed, satelliteOnly, problems, report } = evaluateCoverage(engines, assets, { bsqlVersion });

  process.stdout.write(report);

  if (problems.length) {
    console.error('PREBUILD COVERAGE FAIL:');
    for (const p of problems) console.error(`  ✖ ${p}`);
    return 1;
  }

  console.log(
    `prebuild-coverage OK — engines-allowed majors: ${allowed.join(', ')}; hub majors have darwin+linux+win32 prebuilds` +
      (satelliteOnly.length ? `; satellite-only (source build): ${satelliteOnly.join(', ')}` : ''),
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
