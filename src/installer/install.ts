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
  chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, openSync,
  realpathSync, readdirSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { binDir, modelsDir, runDir, logsDir, recallRoot, dbPath } from '../paths.js';
import { getDb, isBindingLoadError, isRetrievalMigrationPending } from '../db.js';
import { getEmbedVersionStats, getEmbeddingGapStats } from '../recall/message-store.js';
import {
  runPreflight, preflightPassed, acquireInstallLock, releaseInstallLock,
  startInstallLockHeartbeat,
  claudeRecallSkillPath, claudeSettingsPath, claudeMdPath,
  codexAgentsPath, codexHooksPath, codexRecallSkillPath,
  type PreflightReport,
} from './preflight.js';
import type { RetrievalMigrationResult } from './retrieval-class-migration.js';
import { buildManifest, renderManifest } from './manifest.js';
import { runGpuPhase, type GpuPhaseResult, type GpuProbeArgs, type OffloadProbeResult } from './gpu.js';
import { mergeStopHook, removeStopHook, backupFile, mergeStatusLine, removeStatusLine } from './settings-merge.js';
import { detectStatusline, renderStatuslineSuggestion } from './statusline-suggest.js';
import { writeStatuslineConfig, clearStatuslineConfig, readConfig } from './config.js';
import { stableNodePath } from './stable-node.js';
import {
  classifyUpgrade, snapshotDb, handleIntegrity, backfillAlreadyRunning, migrationReportLine,
  type UpgradeState, type IntegrityStatus,
} from './upgrade-migrate.js';
import { applyNudge } from './claudemd-nudge.js';
import { ensureBinary, ensureModel, getBinaryPath, getModelPath } from '../recall/embedder.js';
import { log } from '../log.js';

const STAGED_BUNDLES = ['recall.js', 'stop-hook.js', 'embed-pending.js', 'statusline.js'];

export interface InstallOptions {
  yes?: boolean;
  offline?: boolean;
  noClaudemd?: boolean;
  /** Opt in to the statusLine feature (enable-only; default off). */
  statusline?: boolean;
  /** Force the statusLine feature off (wins over --statusline if both passed). */
  noStatusline?: boolean;
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

/** In-place upgrade migration outcome, surfaced for the report + tests. */
export interface MigrationInfo {
  state: UpgradeState;
  /** Fraction of vectors at EMBED_VERSION at report time (`< 1` → re-embed in flight). */
  coverage: number;
  /** Whether a background re-embed/backfill was launched this run. */
  drainLaunched: boolean;
  /** Pre-flip rollback snapshot (upgrade only). */
  snapshotPath?: string;
  /** Post-flip integrity result (upgrade only). */
  integrity?: IntegrityStatus;
  /** Retrieval-class migration outcome (when one ran or was attempted). */
  retrieval?: RetrievalMigrationResult;
}

export interface InstallResult {
  aborted?: boolean;
  /** Human-readable reason when `aborted` — remediation for a busy/corrupt DB. */
  abortReason?: string;
  report: PreflightReport;
  selected: string[];
  gpu: GpuPhaseResult;
  filesWritten: string[];
  backfillPid?: number;
  migration?: MigrationInfo;
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
 *  Pins the installing Node via stableNodePath — same ABI-lock reasoning as the
 *  Stop hook command (settings-merge.ts): the CLI bundle loads the ABI-locked
 *  better_sqlite3.node and must run under the Node it was built for, but pinned
 *  to the upgrade-stable shim (not the Cellar path brew upgrade deletes). Both
 *  paths are quoted (spaces in ~/.recall / user home). */
function recallBinCommand(): string {
  return `"${stableNodePath()}" "${join(binDir(), 'recall.js')}"`;
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

/** Result of staging: ok, or a hard abort with the user-facing remediation. */
type StageResult = { ok: true } | { ok: false; remediation: string };

/**
 * Stage `src` at `dest` without ever truncating `dest` in place.
 *
 * An in-place copyFileSync O_TRUNCs the destination. If any live process has
 * that file mmapped — this very installer maps the staged better_sqlite3.node
 * during classifyUpgrade()'s read-only probe — the truncate discards the
 * mapping's relocated (dirty COW) pages (Linux truncate semantics zap private
 * COW pages too), and they re-fault as raw unrelocated file bytes: the next GC
 * weak-callback then jumps through a pristine GOT slot and SIGSEGVs. Writing a
 * sibling temp file and rename()ing it into place swaps only the directory
 * entry — live mappings keep the old inode, the path serves the new bytes.
 *
 * Byte-identical destinations are left untouched (re-install fast path: no
 * truncate, no inode churn).
 */
export function stageFileAtomic(src: string, dest: string): void {
  const bytes = readFileSync(src);
  try {
    if (existsSync(dest) && bytes.equals(readFileSync(dest))) return;
  } catch { /* unreadable dest → restage it */ }
  const tmp = `${dest}.staging-${process.pid}`;
  const mode = statSync(src).mode;
  writeFileSync(tmp, bytes, { mode });
  chmodSync(tmp, mode); // writeFileSync's mode is umask-masked; chmod is not
  try {
    renameSync(tmp, dest);
  } catch (e) {
    // Windows can refuse to replace a file another process holds mapped/open.
    // Renaming the OPEN file itself is allowed there, so move the old one
    // aside and land the new one; sweepStaleStagingFiles reaps the orphan
    // once its holder exits.
    const setAside = `${dest}.old-${process.pid}-${Date.now()}`;
    let movedAside = false;
    try {
      renameSync(dest, setAside);
      movedAside = true;
      renameSync(tmp, dest);
    } catch {
      // If the blocked file was TMP (AV scanning the fresh write), both tmp
      // renames fail while the set-aside succeeded — put the previous file
      // back so dest is never left missing.
      if (movedAside) {
        try { renameSync(setAside, dest); } catch { /* dest lost — re-running install restages it */ }
      }
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Reap leftovers from prior atomic stages: orphaned `.staging-*` temp files
 *  (a crashed installer) and `.old-*` set-asides (Windows kept them alive
 *  until their holder exited). Failures are fine — next install retries. */
function sweepStaleStagingFiles(): void {
  let entries: string[];
  try {
    entries = readdirSync(binDir());
  } catch {
    return;
  }
  for (const f of entries) {
    if (/\.(staging|old)-\d+/.test(f)) {
      try { unlinkSync(join(binDir(), f)); } catch { /* still held — next time */ }
    }
  }
}

function stageBundles(distDir: string, written: string[]): StageResult {
  mkdirSync(binDir(), { recursive: true });
  sweepStaleStagingFiles();
  for (const name of STAGED_BUNDLES) {
    const src = join(distDir, name);
    if (!existsSync(src)) {
      log({ source: 'installer/install', level: 'warn', summary: `bundle ${name} not found in ${distDir} — skipping stage` });
      continue;
    }
    const dest = join(binDir(), name);
    stageFileAtomic(src, dest);
    written.push(dest);
  }
  return stageNativeBinding(written);
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
function stageNativeBinding(written: string[]): StageResult {
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
    return { ok: true };
  }

  const dest = join(binDir(), 'better_sqlite3.node');
  // NEVER copyFileSync in place: classifyUpgrade() has already mapped this
  // exact file into the running installer (openReadonly's staged-binding-first
  // resolution) — see stageFileAtomic for the truncate→lost-relocations→GC
  // SIGSEGV this prevents.
  stageFileAtomic(binding, dest);
  written.push(dest);

  // Verify the freshly-staged addon actually dlopens under THIS Node BEFORE
  // writing the marker that vouches for it. A wrong-ABI binding — npm installed
  // under a different Node than the one now running recall (e.g. Homebrew vs
  // nvm) — fails to dlopen with ERR_DLOPEN_FAILED; abort with a clear two-node
  // message instead of writing a lying marker and then looping at the getDb
  // migration ("re-run recall install", which can never fix an ABI gap).
  const probe = probeStagedBinding(dest);
  if (!probe.ok) {
    const remediation = isBindingLoadError({ message: probe.message })
      ? `The SQLite binding npm installed was built for a different Node than the one running recall ` +
        `(${process.execPath}, ${process.version}). This usually means \`npm install -g\` ran under a ` +
        `different Node (e.g. Homebrew vs nvm). Re-run \`npm install -g crispy-recall\` using the same ` +
        `node that is on your PATH, then \`recall install\`. (${probe.message})`
      : `The staged SQLite binding could not be loaded (${probe.message}). Re-run ` +
        `\`npm install -g crispy-recall\` with the node that is on your PATH, then \`recall install\`.`;
    return { ok: false, remediation };
  }

  // ABI marker: written ONLY after the binding is proven to load under this
  // Node, so nodeModuleVersion is truthful. `recall doctor` reads it to detect a
  // Node-major drift or a stale wasm-era install (marker absent).
  const markerPath = join(binDir(), '.binding-info.json');
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        nodeModuleVersion: process.versions.modules,
        // Upgrade-stable public path, not the Cellar path brew upgrade deletes;
        // doctor's pinnedNodeOk checks existsSync(nodePath), which this satisfies.
        nodePath: stableNodePath(),
      },
      null,
      2,
    ),
  );
  written.push(markerPath);
  return { ok: true };
}

/**
 * Load-probe the staged `better_sqlite3.node` in a SHORT-LIVED child process.
 *
 * Deliberately NOT in-process: requiring the native addon from a fresh path in
 * the long-lived installer (or vitest worker) leaves it loaded and crashes on
 * teardown — better-sqlite3's destructors run over each distinct copied path.
 * A throwaway `node -e 'require(<path>)'` isolates the dlopen: a matching-ABI
 * binding exits 0; a wrong-ABI one exits non-zero with the ERR_DLOPEN_FAILED /
 * NODE_MODULE_VERSION message on stderr, which the caller classifies.
 */
export function probeStagedBinding(dest: string): { ok: true } | { ok: false; message: string } {
  const res = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', dest], {
    encoding: 'utf-8',
    timeout: 20_000,
    windowsHide: true,
  });
  if (res.status === 0) return { ok: true };
  const message =
    (res.stderr || res.stdout || '').trim() ||
    (res.error ? res.error.message : `binding probe exited with code ${res.status}`);
  return { ok: false, message };
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
  // Flag-driven opt-in: --statusline enables the (default-off) statusLine item.
  // Delete LAST so --no-statusline wins if both flags are passed (phase 7 also
  // treats --no-statusline as a true-off: removes recall's statusLine + record).
  if (opts.statusline) selected.add('statusline');
  if (opts.noStatusline) selected.delete('statusline');

  // ---- Acquire install lock (concurrent-install guard) ----
  const lock = acquireInstallLock();
  if (!lock.ok) {
    const msg = `Another install is running (PID ${lock.existingPid}).`;
    if (interactive) note(msg, 'Aborting'); else log({ source: 'installer/install', level: 'error', summary: msg });
    return { aborted: true, report, selected: [...selected], gpu: { mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' }, filesWritten: [] };
  }
  // Heartbeat keeps the lock's ts fresh for the whole (possibly long) install,
  // so observers can distinguish a live installer from a crashed one.
  const stopLockHeartbeat = startInstallLockHeartbeat();

  // Classify the existing DB BEFORE staging rewrites the ABI marker, so the
  // marker read reflects the PRIOR install (wasm-era = absent). Drives the
  // quiesce/snapshot/integrity/drain-gating an in-place upgrade needs.
  const migration = classifyUpgrade();
  // Retrieval-class schema migration pending? (read-only probe; the actual
  // rewrite runs attended in phase 6.7 below.)
  // Avoid a short-lived second native handle on steady-state re-installs: that
  // can destabilize better-sqlite3 during rapid fork teardown. A wasm-era DB
  // is necessarily pending; a native/WAL DB can be checked on the cached
  // installer connection without loading the broad migration module graph.
  let retrievalPending = migration.state === 'needs-migration';
  if (migration.state === 'already-migrated') {
    try {
      retrievalPending = isRetrievalMigrationPending(
        getDb(dbPath(), { allowPendingMigration: true }),
      );
    } catch {
      // Fail closed; the attended phase below will surface actionable detail.
      retrievalPending = true;
    }
  }
  const retrievalMigration = retrievalPending
    ? await import('./retrieval-class-migration.js')
    : undefined;

  const filesWritten: string[] = [];
  let gpu: GpuPhaseResult = { mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' };
  let backfillPid: number | undefined;
  let snapshotPath: string | undefined;
  let integrity: IntegrityStatus | undefined;
  let retrieval: RetrievalMigrationResult | undefined;
  let drainLaunched = false;

  // Hook-restore guard: capture the EXACT prior hook-file contents before any
  // quiesce, so every abort path can put the user's Stop hooks back — a failed
  // migration must never leave recall silently disabled.
  const hookFileBackups = new Map<string, string | null>();
  const captureHookFile = (p: string) => {
    if (hookFileBackups.has(p)) return;
    try { hookFileBackups.set(p, readFileSync(p, 'utf-8')); } catch { hookFileBackups.set(p, null); }
  };
  const restoreQuiescedHooks = () => {
    for (const [p, contents] of hookFileBackups) {
      try {
        if (contents !== null) writeFileSync(p, contents);
      } catch (e) {
        log({ source: 'installer/install', level: 'warn', summary: `could not restore hook file ${p}: ${(e as Error).message}` });
      }
    }
  };

  try {
    // ---- Upgrade quiesce ----
    // Remove the stale Stop hook BEFORE staging the native bundles or opening
    // the DB, so no old writer fires during the exclusive WAL flip or the
    // retrieval-class rewrite. The "hooks wired LAST" invariant guards
    // *adding* hooks at not-yet-staged scripts; *removing* the stale hook
    // early is strictly safer. Phase 7 re-adds the recall hook pointing at
    // the freshly staged stop-hook.js; abort paths restore the exact prior
    // configuration via restoreQuiescedHooks().
    if (migration.state === 'needs-migration' || retrievalPending) {
      for (const p of [claudeSettingsPath(), codexHooksPath()]) {
        captureHookFile(p);
        const r = removeStopHook(p);
        if (r.changed) filesWritten.push(p);
      }
      say('upgrade: quiesced Stop hooks before migration');
    }

    // ---- 2/3. Resolve paths + scaffold ~/.recall/ ----
    for (const d of [binDir(), modelsDir(), runDir(), logsDir()]) mkdirSync(d, { recursive: true });
    const staged = stageBundles(opts.distDir ?? defaultDistDir(), filesWritten);
    if (!staged.ok) {
      // The staged SQLite binding cannot load under this Node — abort NOW, before
      // the marker vouches for it and before getDb loops on "re-run recall install".
      restoreQuiescedHooks();
      if (interactive) note(staged.remediation, 'Install aborted');
      else log({ source: 'installer/install', level: 'error', summary: `install aborted: ${staged.remediation}` });
      return {
        aborted: true, abortReason: staged.remediation, report, selected: [...selected], gpu, filesWritten,
        migration: { state: migration.state, coverage: migration.coverage, drainLaunched: false },
      };
    }
    say(`scaffolded ${recallRoot()}`);

    // ---- 4. CPU runtime (eager) — always the guaranteed fallback ----
    if (opts.offline) {
      const haveBin = existsSync(getBinaryPath());
      const haveModel = existsSync(getModelPath());
      if (!haveBin || !haveModel) {
        const msg =
          `--offline but runtime not pre-staged (binary=${haveBin}, model=${haveModel}). ` +
          'Pre-stage ~/.recall/bin + model (or drop --offline), then re-run `recall install`' +
          (migration.state === 'needs-migration' ? ' (which restores the recall Stop hook).' : '.');
        restoreQuiescedHooks();
        log({ source: 'installer/install', level: 'error', summary: msg });
        return {
          aborted: true, abortReason: msg, report, selected: [...selected], gpu, filesWritten,
          migration: { state: migration.state, coverage: migration.coverage, drainLaunched: false },
        };
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

    // ---- 5.5 Pre-flip snapshot (upgrade only) — rollback artifact before the
    // native binding flips the delete-mode DB to WAL. ----
    if (migration.state === 'needs-migration') {
      snapshotPath = snapshotDb() ?? undefined;
      say(snapshotPath ? `pre-upgrade snapshot: ${snapshotPath}` : 'pre-upgrade snapshot skipped (no DB / copy failed)');
    }

    // ---- 6. Init DB (implicit WAL flip on an upgrade) ----
    // configurePragmas asserts journal_mode='wal'; under contention (a live
    // session still holding the delete-mode DB) the exclusive flip fails and
    // getDb throws. Catch it → clean aborted result with remediation, never a
    // half-migrated brick or a stack trace. The snapshot is preserved.
    // allowPendingMigration: ONLY the installer may open a pre-retrieval-class
    // DB (normal commands fail closed); phase 6.7 below performs the rewrite.
    try {
      getDb(dbPath(), { allowPendingMigration: true });
    } catch (e) {
      // Every branch is self-healing: re-running `recall install` re-quiesces,
      // retries the flip, and re-wires the recall Stop hook removed above.
      const emsg = (e as Error).message;
      const rerun = migration.state === 'needs-migration'
        ? ' Then re-run `recall install` to finish migrating and restore the recall Stop hook.'
        : ' Then re-run `recall install`.';
      let remediation: string;
      if (isBindingLoadError(e)) {
        remediation = `The native SQLite binding failed to load (${emsg}). Run \`recall install\` (or \`recall doctor\`).`;
      } else if (/database is locked|SQLITE_BUSY|busy_timeout/i.test(emsg)) {
        remediation = `A live session is holding the database. Exit all Claude/Codex sessions.${rerun}`;
      } else if (/expected WAL journal_mode/i.test(emsg)) {
        remediation =
          'recall could not enable WAL on this filesystem (e.g. a network / virtual mount). ' +
          `Put ~/.recall on a local disk (or set RECALL_HOME to one).${rerun}`;
      } else {
        remediation = `Could not open the database (${emsg}). Run \`recall doctor --integrity\`; if unrecoverable, rebuild from JSONL with \`recall repair --full\`.${rerun}`;
      }
      restoreQuiescedHooks();
      if (interactive) note(remediation, 'Migration aborted');
      else log({ source: 'installer/install', level: 'error', summary: `migration aborted: ${remediation}` });
      return {
        aborted: true, abortReason: remediation, report, selected: [...selected], gpu, filesWritten,
        migration: {
          state: migration.state, coverage: migration.coverage, drainLaunched: false,
          ...(snapshotPath ? { snapshotPath } : {}),
        },
      };
    }
    say('database initialized');

    // ---- 6.5 Post-flip integrity (upgrade only) ----
    if (migration.state === 'needs-migration') {
      const res = handleIntegrity();
      integrity = res.status;
      if (res.status === 'unrecoverable') {
        const remediation =
          `Database integrity check failed (${res.detail ?? 'unknown'}) and could not be auto-repaired. ` +
          `Your pre-upgrade snapshot is preserved at ${snapshotPath ?? '(snapshot unavailable)'}. ` +
          'Rebuild the index from JSONL with `recall repair --full`, then re-run `recall install` to restore the recall Stop hook.';
        restoreQuiescedHooks();
        if (interactive) note(remediation, 'Migration aborted');
        else log({ source: 'installer/install', level: 'error', summary: `migration aborted: ${remediation}` });
        return {
          aborted: true, abortReason: remediation, report, selected: [...selected], gpu, filesWritten,
          migration: {
            state: migration.state, coverage: migration.coverage, drainLaunched: false, integrity,
            ...(snapshotPath ? { snapshotPath } : {}),
          },
        };
      }
      say(res.status === 'repaired-stem' ? 'upgrade: repaired corrupt _stem index' : 'upgrade: integrity check passed');
    }

    // ---- 6.7 Retrieval-class migration (attended, marker-gated) ----
    // Quiesces the background drain, takes a WAL-safe backup-API snapshot
    // (failure aborts), and rewrites classification + filtered FTS + vector
    // purge + durable marker in ONE transaction. Idempotent on re-run.
    if (retrievalPending) {
      try {
        retrieval = await retrievalMigration!.runRetrievalClassMigration();
        if (retrieval.performed) {
          say(
            `retrieval-class migration: ${retrieval.agentSessions} agent sessions reclassified ` +
            `(${retrieval.agentMessages} messages, ${retrieval.purgedVectors} vectors purged)` +
            (retrieval.unresolvedCodexSessions > 0
              ? ` — ${retrieval.unresolvedCodexSessions} codex-shaped sessions had no surviving transcript and were LEFT searchable (never guessed cold)`
              : ''),
          );
        }
      } catch (e) {
        const remediation = e instanceof retrievalMigration!.RetrievalMigrationAbort
          ? e.message
          : `Retrieval-class migration failed (${(e as Error).message}). The transaction rolled back — ` +
            'your data is unchanged. Re-run `recall install` to retry; `recall doctor --integrity` to inspect.';
        restoreQuiescedHooks();
        if (interactive) note(remediation, 'Migration aborted');
        else log({ source: 'installer/install', level: 'error', summary: `migration aborted: ${remediation}` });
        return {
          aborted: true, abortReason: remediation, report, selected: [...selected], gpu, filesWritten,
          migration: {
            state: migration.state, coverage: migration.coverage, drainLaunched: false,
            ...(snapshotPath ? { snapshotPath } : {}),
            ...(retrieval ? { retrieval } : {}),
          },
        };
      }
    }

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
    if (report.codex && selected.has('codex-hook')) {
      const r = mergeStopHook(codexHooksPath(), hookScript);
      if (r.changed) filesWritten.push(codexHooksPath());
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
    // statusLine (opt-in, Claude-only): write ONLY into an empty slot; for a
    // foreign status line print both options and change nothing.
    if (opts.noStatusline) {
      // True-off: remove recall's own statusLine (never a foreign one) and the
      // config record, so nothing re-selects it on the next install.
      const r = removeStatusLine(claudeSettingsPath());
      if (r.changed) { filesWritten.push(claudeSettingsPath()); say('statusline disabled'); }
      clearStatuslineConfig();
    } else if (selected.has('statusline')) {
      // EXPLICIT = the user asked THIS run (--statusline flag, or checked a box
      // that was not pre-checked). PERSISTED-only selection is upgrade
      // maintenance: it may heal recall's own slot but must never (re)enable —
      // an empty slot then means the user deleted recall's statusLine on
      // purpose, so back off and clear the record (what doctor promises).
      const persisted = readConfig()?.statusline?.installed === true;
      const explicit = Boolean(opts.statusline) || !persisted;
      const cmd = `"${stableNodePath()}" "${join(binDir(), 'statusline.js')}"`;
      const detected = detectStatusline(claudeSettingsPath());
      const mayWrite = detected.kind === 'recall' || (detected.kind === 'none' && explicit);
      const r = mayWrite
        ? mergeStatusLine(claudeSettingsPath(), cmd)
        : ({ state: 'refusedForeign', changed: false } as const);
      if (r.state !== 'refusedForeign') {
        if (r.changed) filesWritten.push(claudeSettingsPath());
        // Refresh the record on EVERY owned pass, not just wroteEmpty: a heal
        // rewrote the pinned node (keep the command corroboration current), and
        // a lost/rebuilt config.json must be reconstructible. Keep the original
        // installedAt when one exists.
        const prevAt = readConfig()?.statusline?.installedAt;
        writeStatuslineConfig({ installed: true, command: cmd, priorStatusLine: null, installedAt: prevAt ?? new Date().toISOString() });
        say(r.state === 'wroteEmpty'
          ? 'statusline enabled (session id will show in your Claude Code status bar)'
          : r.changed
            ? 'statusline re-pinned to the current Node (settings.json updated, backup kept)'
            : 'statusline already enabled');
      } else if (explicit) {
        // Explicit opt-in against a FOREIGN status line: never touch it —
        // print both options.
        const msg = renderStatuslineSuggestion(detected);
        if (interactive) note(msg, 'Add the session id to your existing statusline');
        else log({ source: 'installer/install', level: 'info', summary: msg });
      } else {
        // Persisted opt-in, but the user has since removed or replaced recall's
        // statusline: back off quietly and clear the record so doctor stops
        // warning and future installs stop re-selecting it.
        clearStatuslineConfig();
        log({
          source: 'installer/install', level: 'info',
          summary: 'statusline: you removed or replaced it in settings.json — recall left it alone and cleared its record (re-enable with `recall install --statusline`)',
        });
      }
    }
    // An upgrade touches settings.json twice (quiesce-remove + phase-7 re-add) —
    // collapse to one entry so the count/report reflects distinct files.
    if (filesWritten.length !== new Set(filesWritten).size) {
      filesWritten.splice(0, filesWritten.length, ...new Set(filesWritten));
    }
    say(`wrote ${filesWritten.length} files`);

    // ---- 8. Backfill / re-embed drain (MANDATORY, default = background) ----
    // The detached backfill re-embeds v1 rows → v3 via the version-aware gap
    // selectors, so it IS the migration drain. Gate it: skip only a genuinely
    // redundant drain — already-migrated, all vectors current, AND no embedding
    // gap (coverage counts only vectors that exist, so guard the gap too) — and
    // never spawn a duplicate over a live drain.
    const coverage = getEmbedVersionStats().coverage;
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
      drainLaunched = true;
    } else if (backfillAlreadyRunning()) {
      say('backfill already running in background — not relaunching');
    } else if (migration.state === 'already-migrated' && coverage >= 1 && getEmbeddingGapStats().gapCount === 0) {
      say('already migrated (all vectors current) — no background re-embed needed');
    } else {
      backfillPid = spawnDetachedBackfill();
      drainLaunched = backfillPid !== undefined;
      say(backfillPid ? `backfill running in background (PID ${backfillPid})` : 'backfill could not be launched');
    }
  } catch (e) {
    // Unexpected failures must obey the same hook-restoration invariant as
    // explicit aborts. Without this guard, an exception after quiescing could
    // leave recall silently disabled until the next successful install.
    restoreQuiescedHooks();
    throw e;
  } finally {
    stopLockHeartbeat();
    releaseInstallLock();
  }

  // ---- 9. Final report ----
  const finalCoverage = getEmbedVersionStats().coverage;
  const migrationInfo: MigrationInfo = {
    state: migration.state,
    coverage: finalCoverage,
    drainLaunched,
    ...(snapshotPath ? { snapshotPath } : {}),
    ...(integrity ? { integrity } : {}),
    ...(retrieval ? { retrieval } : {}),
  };
  const migLine = migrationReportLine(finalCoverage);

  if (interactive) {
    const lines = [
      gpu.mode === 'gpu' ? 'GPU acceleration: enabled' : `Embeddings: CPU${gpu.reason ? ` (${gpu.reason})` : ''}`,
      `Files written/edited: ${filesWritten.length}`,
      backfillPid ? `Backfill running in background (PID ${backfillPid}) — check with \`recall status\`.` : 'Backfill: see above',
      ...(migLine ? [migLine] : []),
      'Try it — ask Claude: "what did I work on yesterday?"',
      'Commands: recall doctor · recall status · recall uninstall',
    ];
    outro(lines.join('\n'));
  } else if (migLine) {
    log({ source: 'installer/install', level: 'info', summary: migLine });
  }

  return {
    report, selected: [...selected], gpu, filesWritten, migration: migrationInfo,
    ...(backfillPid ? { backfillPid } : {}),
  };
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
