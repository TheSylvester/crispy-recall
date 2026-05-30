/**
 * doctor — read-only health report (the same pre-flight suite install runs)
 * plus the persisted embedder backend, and an optional DB integrity check.
 *
 * `recall doctor`            → PreflightReport (table or --json)
 * `recall doctor --integrity` → PRAGMA integrity_check + FTS5 self-check
 *
 * @module installer/doctor
 */

import { runPreflight, type PreflightReport } from './preflight.js';
import { readConfig } from './config.js';
import { integrityCheck } from './repair.js';

export interface DoctorOptions {
  json?: boolean;
  integrity?: boolean;
  offline?: boolean;
}

/** Returns a process exit code (0 = healthy, 1 = problems found). */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  if (opts.integrity) return printIntegrity(opts.json ?? false);

  const report = await runPreflight({ ...(opts.offline ? { offline: true } : {}) });
  const embedder = readConfig()?.embedder ?? null;

  if (opts.json) {
    console.log(JSON.stringify({ ...report, embedder }, null, 2));
  } else {
    printTable(report, embedder?.mode ?? 'cpu', embedder?.fallbackReason);
  }
  return report.failures.length > 0 ? 1 : 0;
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
