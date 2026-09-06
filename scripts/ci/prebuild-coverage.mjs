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
 *     24, 25, 26) load the native binding. They MUST have a prebuild for EVERY
 *     documented OS/architecture pair (README "Requirements": Linux x64/arm64,
 *     macOS x64/arm64, Windows x64) — a missing pair is a hard FAIL even when
 *     the other architecture of that OS is present.
 *   - SATELLITE_ONLY majors (20) never load the binding. npm still installs the
 *     dependency and compiles it from source, which is a documented, accepted
 *     cost (python3 + make + a C/C++ compiler must be present). Reported, never
 *     a failure.
 *   - Anything else `engines` admits is a FAIL: either it needs prebuilds it
 *     does not have, or nobody decided what role it plays.
 *
 * KNOWN-MAJOR HORIZON: this guard evaluates the Node majors in its ABI table
 * (20..26 today) and every major below that horizon that `engines` admits (an
 * admitted major with no table entry FAILs instead of being skipped — the
 * pre-fix bug: the table started at 22, so admitted 20 and 21 were never
 * considered). `engines` ends in an open `>=24.0.0`, so majors ABOVE the
 * horizon are admitted at install time but are NOT evaluated here; the report
 * says so. When Node 27+ ships and support is verified, extend ABI (and
 * HUB_MAJORS) — nothing here predicts or vouches for an unreleased major.
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

/** OS/architecture pairs a hub major must have a prebuild for (README "Requirements"). */
export const REQUIRED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

/** Lowest major probed below the table for admitted-but-unknown majors. */
const PROBE_FLOOR = 14;

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
 * @returns {{allowed:number[], hub:number[], satelliteOnly:number[], horizon:number, openAboveHorizon:boolean, gaps:object[], problems:string[], report:string}}
 */
export function evaluateCoverage(enginesString, assetNames, opts = {}) {
  const bsqlVersion = opts.bsqlVersion ?? 'unknown';

  // ABI -> Set("<os>-<arch>") from `...-node-v<ABI>-<os>-<arch>.tar.gz`.
  const byAbi = new Map();
  for (const a of assetNames) {
    // Anchored on `-` and `.tar.gz` so `linuxmusl-x64` can never stand in for
    // the glibc `linux-x64` prebuild.
    const m = String(a).match(/node-v(\d+)-(darwin|linux|win32)-([a-z0-9]+)\.tar\.gz$/);
    if (!m) continue; // electron-*, linuxmusl-*, checksums: not our runtime
    const abi = Number(m[1]);
    if (!byAbi.has(abi)) byAbi.set(abi, new Set());
    byAbi.get(abi).add(`${m[2]}-${m[3]}`);
  }
  const targetsFor = (maj) => [...(byAbi.get(ABI[maj]) ?? new Set())].sort();

  const horizon = Math.max(...Object.keys(ABI).map(Number));
  const probe = Array.from({ length: horizon - PROBE_FLOOR + 1 }, (_, i) => PROBE_FLOOR + i);
  const allowed = probe.filter((maj) => majorAllowed(maj, enginesString));
  // Does `engines` admit anything past the horizon? Reported, not evaluated.
  const openAboveHorizon = majorAllowed(horizon + 1, enginesString);
  const problems = [];
  const gaps = [];

  // An admitted major at or below the horizon with no ABI entry is a FAIL,
  // never a silent skip.
  const unknown = allowed.filter((maj) => ABI[maj] === undefined);
  for (const maj of unknown) {
    problems.push(
      `Node ${maj} is allowed by engines but has no entry in the ABI table — add it (with its NODE_MODULE_VERSION) and decide its role`,
    );
  }

  const known = allowed.filter((maj) => ABI[maj] !== undefined);
  const hub = known.filter((maj) => HUB_MAJORS.includes(maj));
  const satelliteOnly = known.filter((maj) => SATELLITE_ONLY.includes(maj) && !HUB_MAJORS.includes(maj));
  const unclassified = known.filter((maj) => !HUB_MAJORS.includes(maj) && !SATELLITE_ONLY.includes(maj));

  for (const maj of hub) {
    const have = targetsFor(maj);
    const missing = REQUIRED_TARGETS.filter((t) => !have.includes(t));
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
  lines.push(`engines.node = \`${enginesString}\` → evaluated majors (known table ${Math.min(...Object.keys(ABI).map(Number))}–${horizon}): ${allowed.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('| Node major | ABI | role | node prebuilds (os-arch) | verdict |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const maj of allowed) {
    const abi = ABI[maj];
    if (abi === undefined) {
      lines.push(`| ${maj} | ? | UNKNOWN | ? | ❌ not in the ABI table |`);
      continue;
    }
    const have = targetsFor(maj);
    const role = HUB_MAJORS.includes(maj) ? 'hub' : SATELLITE_ONLY.includes(maj) ? 'satellite-only' : 'UNCLASSIFIED';
    let verdict;
    if (role === 'hub') {
      const missing = REQUIRED_TARGETS.filter((t) => !have.includes(t));
      verdict = missing.length ? `❌ MISSING ${missing.join(', ')}` : `✅ all ${REQUIRED_TARGETS.length} documented os-arch pairs`;
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
  lines.push('');
  lines.push(
    gaps.length
      ? `**Hub coverage gaps:** ${gaps.map((g) => `Node ${g.major} (ABI ${g.abi}) missing ${g.missing.join('/')}`).join('; ')}`
      : `**No hub coverage gaps** over the documented pairs (${REQUIRED_TARGETS.join(', ')}).`,
  );
  if (satelliteOnly.length) {
    lines.push('');
    lines.push(
      `**Satellite-only majors:** ${satelliteOnly.join(', ')} — no prebuild, so npm compiles better-sqlite3 from source. python3, make and a C/C++ compiler must be present even though a satellite never loads the binding.`,
    );
  }
  lines.push('');
  lines.push(
    openAboveHorizon
      ? `**Horizon:** this guard evaluates Node majors up to ${horizon} (the ABI table). \`engines\` also admits later majors at install time; they are NOT evaluated or vouched for here — extend the ABI table (and HUB_MAJORS) when a newer Node is verified.`
      : `**Horizon:** this guard evaluates Node majors up to ${horizon} (the ABI table); \`engines\` admits nothing beyond it.`,
  );
  const report = lines.join('\n') + '\n';

  return { allowed, hub, satelliteOnly, horizon, openAboveHorizon, gaps, problems: [...new Set(problems)], report };
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
    `prebuild-coverage OK — evaluated majors: ${allowed.join(', ')}; hub majors have every documented os-arch prebuild` +
      (satelliteOnly.length ? `; satellite-only (source build): ${satelliteOnly.join(', ')}` : '') +
      ' (known-major horizon only)',
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
