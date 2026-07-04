/**
 * install — orchestrates the recall install phases.
 *
 * Phase order (see day-5 spec §2): pre-flight → upfront manifest (consent
 * collected ONCE) → resolve paths → scaffold ~/.recall + stage bundles →
 * download CPU runtime (or verify --offline staging) → MANDATORY GPU phase →
 * init DB → Claude/Codex filesystem edits (LAST, so a partial install never
 * leaves hooks pointing at missing scripts) → detached backfill → final report.
 *
 * Delegates: GPU → gpu.ts, the opt-out checklist → manifest.ts, hook merge →
 * settings-merge.ts, the CLAUDE.md/AGENTS.md nudge → claudemd-nudge.ts.
 *
 * @module installer/install
 */

import {
  intro, outro, note, log as clog, spinner, confirm, isCancel,
} from '@clack/prompts';
import {
  existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, openSync,
  realpathSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { binDir, modelsDir, runDir, logsDir, recallRoot, dbPath } from '../paths.js';
import { getDb } from '../db.js';
import {
  runPreflight, preflightPassed, acquireInstallLock, releaseInstallLock,
  claudeRecallSkillPath, claudeSettingsPath, claudeMdPath,
  codexAgentsPath, codexRecallSkillPath,
  type PreflightReport,
} from './preflight.js';
import { buildManifest, renderManifest } from './manifest.js';
import { runGpuPhase, type GpuPhaseResult, type GpuProbeArgs, type OffloadProbeResult } from './gpu.js';
import { mergeStopHook, backupFile } from './settings-merge.js';
import { applyNudge } from './claudemd-nudge.js';
import { ensureBinary, ensureModel, getBinaryPath, getModelPath } from '../recall/embedder.js';
import { log } from '../log.js';

const STAGED_BUNDLES = ['recall.js', 'stop-hook.js', 'embed-pending.js'];

export interface InstallOptions {
  yes?: boolean;
  offline?: boolean;
  noClaudemd?: boolean;
  noBackfill?: boolean;
  autoBackfill?: boolean; // foreground backfill with a spinner (for tests)
  json?: boolean;
  /** Source directory of the dist bundles to stage into ~/.recall/bin/. */
  distDir?: string;
  /** Override the SKILL.md template path (defaults to a resolver). */
  templatePath?: string;
  /** Injectable GPU hooks (forwarded to the GPU phase) — for tests. */
  gpuDetect?: () => Promise<boolean>;
  gpuProbe?: (args: GpuProbeArgs) => Promise<OffloadProbeResult>;
}

export interface InstallResult {
  aborted?: boolean;
  report: PreflightReport;
  selected: string[];
  gpu: GpuPhaseResult;
  filesWritten: string[];
  backfillPid?: number;
}

// ---------------------------------------------------------------------------
// Path / template resolution
// ---------------------------------------------------------------------------

export function defaultDistDir(): string {
  // When run as `node dist/recall.js install`, argv[1] is the bundle path.
  // Under a global npm install `recall` is a symlink (bin/recall →
  // ../lib/node_modules/crispy-recall/dist/recall.js), so argv[1] is the
  // symlink in bin/, not the dist dir. Resolve it to realpath before taking
  // the dirname, or staging the bundles into ~/.recall/bin/ silently no-ops
  // and the wired Stop hook points at a missing stop-hook.js.
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return dirname(realpathSync(argv1));
    } catch {
      return dirname(argv1);
    }
  }
  return __dirname;
}

/** Resolve the SKILL.md template across bundled + source layouts. */
function resolveTemplatePath(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;
  const here = __dirname;
  const candidates = [
    join(here, 'SKILL.md.template'),               // bundled: copied next to recall.js
    join(here, '..', 'skill', 'SKILL.md.template'), // dist/ sibling skill/
    join(here, '..', '..', 'skill', 'SKILL.md.template'), // source: src/installer/
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[candidates.length - 1]!;
}

/** The directly-runnable command the skill body uses (NOT a bare path).
 *  Pins the installing Node's absolute path — same ABI-lock reasoning as the
 *  Stop hook command (settings-merge.ts): the CLI bundle loads the ABI-locked
 *  better_sqlite3.node and must run under the Node it was built for. Both paths
 *  are quoted (spaces in ~/.recall / user home). */
function recallBinCommand(): string {
  return `"${process.execPath}" "${join(binDir(), 'recall.js')}"`;
}

// ---------------------------------------------------------------------------
// Filesystem-edit helpers
// ---------------------------------------------------------------------------

/** Write the recall skill from the template with $RECALL_BIN substituted. */
function writeSkill(targetPath: string, templatePath: string, runnable: string): boolean {
  const template = readFileSync(templatePath, 'utf-8');
  const body = template.replaceAll('$RECALL_BIN', runnable);
  mkdirSync(dirname(targetPath), { recursive: true });
  if (existsSync(targetPath)) {
    if (readFileSync(targetPath, 'utf-8') === body) return false;
    backupFile(targetPath);
  }
  writeFileSync(targetPath, body);
  return true;
}

function stageBundles(distDir: string, written: string[]): void {
  mkdirSync(binDir(), { recursive: true });
  for (const name of STAGED_BUNDLES) {
    const src = join(distDir, name);
    if (!existsSync(src)) {
      log({ source: 'installer/install', level: 'warn', summary: `bundle ${name} not found in ${distDir} — skipping stage` });
      continue;
    }
    const dest = join(binDir(), name);
    copyFileSync(src, dest);
    written.push(dest);
  }
  stageNativeBinding(written);
}

/**
 * Stage the ABI-matching `better_sqlite3.node` beside the bundles, plus a
 * `.binding-info.json` marker, and remove any leftover wasm sidecar.
 *
 * The addon is resolved from THIS installer's own node_modules (Node's real
 * resolution), NOT from distDir: `dist/better_sqlite3.node` is the *builder's*
 * platform addon (correct for local build/test only), whereas each machine must
 * stage the prebuild matching its own installing Node. The installed bundles
 * compute `nativeBinding` as `join(__dirname, 'better_sqlite3.node')`, so it
 * must sit directly beside them in binDir().
 */
function stageNativeBinding(written: string[]): void {
  // Restage hygiene: drop a pre-migration wasm sidecar — the bundles now load
  // better_sqlite3.node and would ignore it, but leaving it is misleading.
  const staleWasm = join(binDir(), 'node-sqlite3-wasm.wasm');
  if (existsSync(staleWasm)) {
    try { unlinkSync(staleWasm); } catch { /* best-effort */ }
  }

  const binding = resolveInstalledBinding();
  if (!binding) {
    log({
      source: 'installer/install',
      level: 'warn',
      summary: 'better_sqlite3.node not found in node_modules — the CLI/hooks will fail to load SQLite until reinstalled',
    });
    return;
  }

  const dest = join(binDir(), 'better_sqlite3.node');
  copyFileSync(binding, dest);
  written.push(dest);

  // ABI marker: `recall doctor` uses it to detect a Node-major drift (module
  // version mismatch) or a stale wasm-era install (marker absent) and advise
  // `recall install --restage`.
  const markerPath = join(binDir(), '.binding-info.json');
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        nodeModuleVersion: process.versions.modules,
        nodePath: process.execPath,
      },
      null,
      2,
    ),
  );
  written.push(markerPath);
}

/** Resolve the installed better-sqlite3 addon via Node's real module
 *  resolution (respects hoisting), then locate its compiled `.node`. */
function resolveInstalledBinding(): string | null {
  try {
    const pkgJson = createRequire(__filename).resolve('better-sqlite3/package.json');
    return findDotNode(dirname(pkgJson));
  } catch {
    return null;
  }
}

/** Find better_sqlite3.node under a package dir: canonical gyp output first,
 *  then a bounded recursive scan (covers prebuild-install `prebuilds/…`). */
function findDotNode(baseDir: string): string | null {
  for (const c of [
    join(baseDir, 'build', 'Release', 'better_sqlite3.node'),
    join(baseDir, 'build', 'Debug', 'better_sqlite3.node'),
  ]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.node')) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runInstall(opts: InstallOptions = {}): Promise<InstallResult> {
  const interactive = !!process.stdout.isTTY && !opts.yes && !opts.json;
  const say = (msg: string) => {
    if (interactive) clog.step(msg);
    else log({ source: 'installer/install', level: 'info', summary: msg });
  };

  if (interactive) intro('recall install');

  // ---- 0. Pre-flight ----
  const report = await runPreflight({
    ...(opts.offline ? { offline: true } : {}),
    ...(opts.gpuDetect ? { gpuDetect: opts.gpuDetect } : {}),
  });

  if (!preflightPassed(report)) {
    const msg = report.failures.map((f) => `✖ ${f.check}: ${f.message}${f.remediation ? `\n   → ${f.remediation}` : ''}`).join('\n');
    if (interactive) note(msg, 'Pre-flight failed'); else log({ source: 'installer/install', level: 'error', summary: `pre-flight failed:\n${msg}` });
    return { aborted: true, report, selected: [], gpu: { mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' }, filesWritten: [] };
  }

  if (report.warnings.length) {
    const wmsg = report.warnings.map((w) => `• ${w.check}: ${w.message}`).join('\n');
    if (interactive) {
      note(wmsg, 'Warnings');
      const go = await confirm({ message: 'Continue with these warnings?' });
      if (isCancel(go) || !go) return { aborted: true, report, selected: [], gpu: { mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' }, filesWritten: [] };
    } else {
      log({ source: 'installer/install', level: 'warn', summary: `pre-flight warnings:\n${wmsg}` });
    }
  }

  // ---- 1. Manifest (consent, before any mutation) ----
  const manifest = buildManifest(report);
  const selected = await renderManifest(manifest, {
    yes: opts.yes ?? false,
    interactive,
    logLine: (m) => log({ source: 'installer/install', level: 'info', summary: m }),
  });
  // Flag-driven opt-out: --no-claudemd deselects the CLAUDE.md/AGENTS.md nudge.
  if (opts.noClaudemd) { selected.delete('claudemd'); selected.delete('codex-agentsmd'); }

  // ---- Acquire install lock (concurrent-install guard) ----
  const lock = acquireInstallLock();
  if (!lock.ok) {
    const msg = `Another install is running (PID ${lock.existingPid}).`;
    if (interactive) note(msg, 'Aborting'); else log({ source: 'installer/install', level: 'error', summary: msg });
    return { aborted: true, report, selected: [...selected], gpu: { mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' }, filesWritten: [] };
  }

  const filesWritten: string[] = [];
  let gpu: GpuPhaseResult = { mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' };
  let backfillPid: number | undefined;

  try {
    // ---- 2/3. Resolve paths + scaffold ~/.recall/ ----
    for (const d of [binDir(), modelsDir(), runDir(), logsDir()]) mkdirSync(d, { recursive: true });
    stageBundles(opts.distDir ?? defaultDistDir(), filesWritten);
    say(`scaffolded ${recallRoot()}`);

    // ---- 4. CPU runtime (eager) — always the guaranteed fallback ----
    if (opts.offline) {
      const haveBin = existsSync(getBinaryPath());
      const haveModel = existsSync(getModelPath());
      if (!haveBin || !haveModel) {
        const msg = `--offline but runtime not pre-staged (binary=${haveBin}, model=${haveModel}).`;
        log({ source: 'installer/install', level: 'error', summary: msg });
        return { aborted: true, report, selected: [...selected], gpu, filesWritten };
      }
      say('offline: CPU runtime already staged');
    } else {
      const sp = interactive ? spinner() : null;
      sp?.start('Downloading CPU runtime (binary + model)…');
      await ensureBinary();
      await ensureModel();
      sp?.stop('CPU runtime ready');
      say('CPU runtime downloaded');
    }

    // ---- 5. GPU phase (MANDATORY) ----
    gpu = await runGpuPhase({
      ...(opts.gpuDetect ? { detect: opts.gpuDetect } : {}),
      ...(opts.gpuProbe ? { probe: opts.gpuProbe } : {}),
      ...(opts.offline ? { offline: true } : {}),
    });
    say(gpu.mode === 'gpu' ? `GPU acceleration enabled (${gpu.cudaAvailable})` : `using CPU embeddings${gpu.reason ? ` (${gpu.reason})` : ''}`);

    // ---- 6. Init DB ----
    getDb(dbPath());
    say('database initialized');

    // ---- 7. Claude / Codex filesystem edits (LAST) ----
    const runnable = recallBinCommand();
    const templatePath = resolveTemplatePath(opts.templatePath);
    const hookScript = join(binDir(), 'stop-hook.js');

    if (selected.has('skill')) {
      if (writeSkill(claudeRecallSkillPath(), templatePath, runnable)) filesWritten.push(claudeRecallSkillPath());
    }
    if (selected.has('stop-hook')) {
      const r = mergeStopHook(claudeSettingsPath(), hookScript);
      if (r.changed) filesWritten.push(claudeSettingsPath());
    }
    if (report.codex && selected.has('codex-skill')) {
      if (writeSkill(codexRecallSkillPath(), templatePath, runnable)) filesWritten.push(codexRecallSkillPath());
    }
    if (selected.has('claudemd')) {
      const r = applyNudge(claudeMdPath());
      if (r.changed) filesWritten.push(claudeMdPath());
    }
    if (report.codex && selected.has('codex-agentsmd')) {
      const r = applyNudge(codexAgentsPath());
      if (r.changed) filesWritten.push(codexAgentsPath());
    }
    say(`wrote ${filesWritten.length} files`);

    // ---- 8. Backfill (MANDATORY, default = background) ----
    if (opts.noBackfill) {
      say('backfill skipped (--no-backfill)');
    } else if (opts.autoBackfill) {
      const sp = interactive ? spinner() : null;
      sp?.start('Backfilling transcripts (foreground)…');
      const { startRecallCatchup } = await import('../recall/catchup.js');
      const { mtimeScan } = await import('../recall/mtime-scan.js');
      await startRecallCatchup({ autoEmbed: true });
      await mtimeScan();
      sp?.stop('Backfill complete');
    } else {
      backfillPid = spawnDetachedBackfill();
      say(backfillPid ? `backfill running in background (PID ${backfillPid})` : 'backfill could not be launched');
    }
  } finally {
    releaseInstallLock();
  }

  // ---- 9. Final report ----
  if (interactive) {
    const lines = [
      gpu.mode === 'gpu' ? 'GPU acceleration: enabled' : `Embeddings: CPU${gpu.reason ? ` (${gpu.reason})` : ''}`,
      `Files written/edited: ${filesWritten.length}`,
      backfillPid ? `Backfill running in background (PID ${backfillPid}) — check with \`recall status\`.` : 'Backfill: see above',
      'Try it — ask Claude: "what did I work on yesterday?"',
      'Commands: recall doctor · recall status · recall uninstall',
    ];
    outro(lines.join('\n'));
  }

  return { report, selected: [...selected], gpu, filesWritten, ...(backfillPid ? { backfillPid } : {}) };
}

/** Spawn `recall backfill --auto-embed` detached; record run/backfill.pid. */
function spawnDetachedBackfill(): number | undefined {
  mkdirSync(runDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
  const recallBundle = join(binDir(), 'recall.js');
  const logFd = openSync(join(logsDir(), 'backfill.log'), 'a');
  const child = spawn(process.execPath, [recallBundle, 'backfill', '--auto-embed'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env },
  });
  if (child.pid !== undefined) {
    writeFileSync(join(runDir(), 'backfill.pid'), String(child.pid));
  }
  child.unref();
  return child.pid;
}
