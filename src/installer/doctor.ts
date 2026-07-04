/**
 * doctor — read-only health report (the same pre-flight suite install runs)
 * plus the persisted embedder backend, and an optional DB integrity check.
 *
 * `recall doctor`            → PreflightReport (table or --json)
 * `recall doctor --integrity` → PRAGMA integrity_check + FTS5 self-check
 *
 * @module installer/doctor
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runPreflight, type PreflightReport } from './preflight.js';
import { readConfig } from './config.js';
import { integrityCheck } from './repair.js';
import { isBindingLoadError } from '../db.js';
import { binDir, dbPath } from '../paths.js';
import { EMBED_VERSION } from '../recall/embed-config.js';

export interface DoctorOptions {
  json?: boolean;
  integrity?: boolean;
  offline?: boolean;
}

/**
 * Native-binding + WAL drift health. Read-only: it opens the DB `readonly` and
 * only READS `journal_mode` — it never runs `journal_mode = WAL`, so it can
 * never implicitly convert the live DB (that is an attended, separate event).
 */
export interface BindingHealth {
  installed: boolean;        // recall bundles staged at all?
  markerPresent: boolean;    // .binding-info.json (absent = pre-migration wasm-era install)
  abiOk: boolean | null;     // staged ABI matches current Node (null if no marker)
  pinnedNodeOk: boolean | null; // pinned node path still exists (null if no marker)
  bindingLoads: boolean;     // better_sqlite3.node loads under this Node
  journalMode: string | null;   // current mode on the live DB (null if DB absent/unreadable)
  /** Fraction of vectors at EMBED_VERSION (null if DB absent / no vectors table).
   *  `< 1` surfaces an in-progress embed_version re-embed — read on the SAME
   *  readonly connection as journalMode, so doctor never flips the live DB. */
  embedCoverage: number | null;
  problems: string[];
}

/** Returns a process exit code (0 = healthy, 1 = problems found). */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  if (opts.integrity) return printIntegrity(opts.json ?? false);

  const report = await runPreflight({ ...(opts.offline ? { offline: true } : {}) });
  const embedder = readConfig()?.embedder ?? null;
  const binding = checkBindingHealth();

  if (opts.json) {
    console.log(JSON.stringify({ ...report, embedder, binding }, null, 2));
  } else {
    printTable(report, embedder?.mode ?? 'cpu', embedder?.fallbackReason);
    printBinding(binding);
  }
  const bindingFailed = binding.installed && binding.problems.length > 0;
  return report.failures.length > 0 || bindingFailed ? 1 : 0;
}

/** Path to the staged addon (beside the bundles). */
function stagedBindingPath(): string {
  return join(binDir(), 'better_sqlite3.node');
}

function checkBindingHealth(): BindingHealth {
  const problems: string[] = [];
  const installed = existsSync(join(binDir(), 'recall.js'));
  if (!installed) {
    return {
      installed: false, markerPresent: false, abiOk: null, pinnedNodeOk: null,
      bindingLoads: false, journalMode: null, embedCoverage: null,
      problems: ['recall is not installed — run `recall install`'],
    };
  }

  // --- ABI marker ---
  const markerPath = join(binDir(), '.binding-info.json');
  const markerPresent = existsSync(markerPath);
  let abiOk: boolean | null = null;
  let pinnedNodeOk: boolean | null = null;
  if (!markerPresent) {
    problems.push('no .binding-info.json marker — pre-migration (wasm-era) install; run `recall install --restage`');
  } else {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
        nodeModuleVersion?: string; nodePath?: string;
      };
      abiOk = String(marker.nodeModuleVersion) === String(process.versions.modules);
      if (!abiOk) {
        problems.push(
          `binding ABI mismatch (staged for NODE_MODULE_VERSION ${marker.nodeModuleVersion}, ` +
            `current ${process.versions.modules}) — run \`recall install --restage\``,
        );
      }
      pinnedNodeOk = !!marker.nodePath && existsSync(marker.nodePath);
      if (!pinnedNodeOk) {
        problems.push(`pinned Node path missing (${marker.nodePath ?? 'unset'}) — run \`recall install --restage\``);
      }
    } catch {
      problems.push('unreadable .binding-info.json marker — run `recall install --restage`');
    }
  }

  // --- Binding load + WAL drift (read-only) ---
  let bindingLoads = false;
  let journalMode: string | null = null;
  let embedCoverage: number | null = null;
  const localBinding = stagedBindingPath();
  const dbFile = dbPath();
  if (existsSync(dbFile)) {
    try {
      const raw = existsSync(localBinding)
        ? new Database(dbFile, { readonly: true, fileMustExist: true, nativeBinding: localBinding })
        : new Database(dbFile, { readonly: true, fileMustExist: true });
      bindingLoads = true;
      journalMode = String(raw.pragma('journal_mode', { simple: true }));
      // Embed-version coverage on the SAME readonly connection (never flips WAL).
      try {
        const row = raw
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN embed_version = ? THEN 1 ELSE 0 END), 0) AS current
             FROM message_vectors`,
          )
          .get(EMBED_VERSION) as { total: number; current: number } | undefined;
        const total = row ? Number(row.total) : 0;
        const current = row ? Number(row.current ?? 0) : 0;
        embedCoverage = total === 0 ? null : current / total;
      } catch {
        embedCoverage = null; // no vectors table / no embed_version column
      }
      raw.close();
      if (journalMode !== 'wal') {
        problems.push(
          `live DB journal_mode is '${journalMode}', not 'wal' — a native build on a non-WAL DB is drift ` +
            `(the WAL conversion is a separate attended step; do not restage over a delete-mode DB blindly)`,
        );
      }
    } catch (e) {
      if (isBindingLoadError(e)) {
        problems.push('better_sqlite3.node failed to load (ABI/dlopen) — run `recall install --restage`');
      } else {
        problems.push(`could not read live DB journal_mode: ${(e as Error).message}`);
      }
    }
  } else {
    // No DB yet — prove the binding at least loads against an in-memory DB.
    try {
      const raw = existsSync(localBinding)
        ? new Database(':memory:', { nativeBinding: localBinding })
        : new Database(':memory:');
      bindingLoads = true;
      raw.close();
    } catch (e) {
      problems.push(
        isBindingLoadError(e)
          ? 'better_sqlite3.node failed to load (ABI/dlopen) — run `recall install --restage`'
          : `binding self-test failed: ${(e as Error).message}`,
      );
    }
  }

  return { installed, markerPresent, abiOk, pinnedNodeOk, bindingLoads, journalMode, embedCoverage, problems };
}

function printBinding(b: BindingHealth): void {
  const ok = (v: boolean) => (v ? 'OK' : 'FAIL');
  console.log('\nSQLite binding (better-sqlite3, native WAL)');
  console.log('------------------------------------------');
  if (!b.installed) {
    console.log('  not installed — run `recall install`');
    return;
  }
  console.log(`Binding loads:  ${ok(b.bindingLoads)}`);
  console.log(`ABI marker:     ${b.markerPresent ? (b.abiOk ? 'OK' : 'MISMATCH') : 'absent (wasm-era)'}`);
  console.log(`Pinned Node:    ${b.pinnedNodeOk === null ? 'n/a' : ok(b.pinnedNodeOk)}`);
  console.log(`journal_mode:   ${b.journalMode ?? 'no DB yet'}${b.journalMode && b.journalMode !== 'wal' ? '  [DRIFT]' : ''}`);
  if (b.embedCoverage !== null && b.embedCoverage < 1) {
    console.log(`Embed migration: re-embedding to v${EMBED_VERSION} (${Math.round(b.embedCoverage * 100)}%) — semantic search stays available`);
  }
  if (b.problems.length) {
    console.log('  Issues:');
    for (const p of b.problems) console.log(`   ✖ ${p}`);
  }
}

function printIntegrity(json: boolean): number {
  const r = integrityCheck();
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`Main DB integrity_check: ${r.mainOk ? 'ok' : r.mainDetail}`);
    console.log(`FTS5 self-check:         ${r.ftsOk ? 'ok' : `FAILED (${r.ftsError})`}`);
    if (!r.mainOk) console.log('  → serious corruption — run `recall repair --full`.');
    else if (!r.ftsOk) console.log('  → run `recall repair --fts`.');
  }
  return r.mainOk && r.ftsOk ? 0 : 1;
}

function printTable(report: PreflightReport, embedderMode: 'gpu' | 'cpu', fallbackReason?: string): void {
  const ok = (b: boolean) => (b ? 'OK' : 'FAIL');
  console.log('recall doctor');
  console.log('=============');
  console.log(`Platform:   ${report.platform.os}/${report.platform.arch}${report.platform.isWsl ? ' (WSL)' : ''}  [${ok(report.platform.ok)}]`);
  console.log(`Claude:     ${report.claude.status}  hooks=${report.claude.existingHooks}  install=${report.claude.existingInstall}  [${ok(report.claude.ok)}]`);
  console.log(`Codex:      ${report.codex ? `${report.codex.status} [${ok(report.codex.ok)}]` : 'not detected'}`);
  console.log(`Node:       ${report.runtime.node}`);
  console.log(`Disk:       ${report.runtime.disk}`);
  console.log(`Network:    ${report.runtime.network}`);
  console.log(`Arch:       ${report.runtime.binaryArch}`);
  const g = report.runtime.gpu;
  console.log(`GPU:        detected=${g.detected} vendor=${g.vendor}${g.vram ? ` vram=${g.vram}` : ''} cuda=${g.cudaAvailable} planned=${g.plannedMode}`);
  console.log(`Embedder:   ${embedderMode.toUpperCase()} (persisted)${fallbackReason ? ` — fell back: ${fallbackReason}` : ''}`);

  if (report.warnings.length) {
    console.log('\nWarnings:');
    for (const w of report.warnings) console.log(`  • ${w.check}: ${w.message}`);
  }
  if (report.failures.length) {
    console.log('\nFailures:');
    for (const f of report.failures) console.log(`  ✖ ${f.check}: ${f.message}${f.remediation ? `\n     → ${f.remediation}` : ''}`);
  }
  if (!report.warnings.length && !report.failures.length) console.log('\nAll checks passed.');
}
