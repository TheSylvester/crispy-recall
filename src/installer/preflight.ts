/**
 * Pre-flight — structured environment checks shared by `install` and `doctor`.
 *
 * Returns a JSON-serializable PreflightReport. Pure inspection plus the
 * install-lock primitives (acquire/release live here so install and doctor
 * share one definition). No mutation of Claude/Codex territory and no GPU
 * staging — those are install-phase side effects (install.ts / gpu.ts).
 *
 * Also the canonical source for harness path resolution (claude/codex dirs),
 * honoring CLAUDE_CONFIG_DIR / CODEX_HOME so tests can redirect them.
 *
 * @module installer/preflight
 */

import {
  existsSync, readFileSync, writeFileSync, accessSync, unlinkSync,
  constants as fsConstants, statfsSync, mkdirSync, statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recallRoot, runDir } from '../paths.js';
import { detectGpu, type GpuInfo } from './gpu.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type PreflightIssue = {
  check: string;
  severity: 'WARN' | 'FAIL';
  message: string;
  remediation?: string;
};

export type { GpuInfo };

export type PreflightReport = {
  platform: { os: string; arch: string; isWsl: boolean; ok: boolean };
  claude: { ok: boolean; status: string; paths: Record<string, string>; existingHooks: number; existingInstall: boolean };
  codex: { ok: boolean; status: string; paths: Record<string, string> } | null;
  runtime: { node: string; disk: string; network: string; binaryArch: string; gpu: GpuInfo };
  warnings: PreflightIssue[];
  failures: PreflightIssue[];
};

export interface PreflightOptions {
  offline?: boolean;
  /** Injectable GPU detect for tests (forwarded to detectGpu). */
  gpuDetect?: () => Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injectable macOS product-version reader (tests). Returns e.g. "13.5", or
   *  null when unavailable. Defaults to spawning `sw_vers -productVersion`. */
  macosProductVersion?: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Harness path resolution (canonical)
// ---------------------------------------------------------------------------

/** ~/.claude (or $CLAUDE_CONFIG_DIR). */
export function claudeDir(): string {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  return override && override.length > 0 ? override : join(homedir(), '.claude');
}
export function claudeSettingsPath(): string { return join(claudeDir(), 'settings.json'); }
export function claudeSkillsDir(): string { return join(claudeDir(), 'skills'); }
export function claudeRecallSkillPath(): string { return join(claudeSkillsDir(), 'recall', 'SKILL.md'); }
export function claudeMdPath(): string { return join(claudeDir(), 'CLAUDE.md'); }

/** ~/.codex (or $CODEX_HOME). */
export function codexDir(): string {
  const override = process.env['CODEX_HOME'];
  return override && override.length > 0 ? override : join(homedir(), '.codex');
}
export function codexHooksPath(): string { return join(codexDir(), 'hooks.json'); }
export function codexAgentsPath(): string { return join(codexDir(), 'AGENTS.md'); }
export function codexRecallSkillPath(): string { return join(codexDir(), 'skills', 'recall', 'SKILL.md'); }

// ---------------------------------------------------------------------------
// Install lock (concurrent-install detection)
// ---------------------------------------------------------------------------

const STALE_LOCK_MS = 60 * 60 * 1000; // 1 hour — applies ONLY to unreadable/dead locks

function installLockPath(): string { return join(runDir(), 'install.lock'); }

interface LockBody { pid: number; ts: number; token?: string }

function readLockBody(): LockBody | null {
  try {
    return JSON.parse(readFileSync(installLockPath(), 'utf-8')) as LockBody;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this user cannot signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Random ownership token for THIS process's lock tenure. Release and
 *  heartbeat verify it, so a same-PID successor (PID reuse) or a racing
 *  installer can never be mistaken for us. */
let ownLockToken: string | null = null;

function newLockBody(): string {
  ownLockToken = randomBytes(8).toString('hex');
  return JSON.stringify({ pid: process.pid, ts: Date.now(), token: ownLockToken } satisfies LockBody);
}

export interface LockAcquisition {
  ok: boolean;
  tookOver: boolean;
  existingPid?: number;
}

/**
 * Atomically acquire the install lock.
 *
 * A VERIFIABLY LIVE owner is never stolen — regardless of age. (The old
 * behavior overwrote any lock after one hour, which could steal from a live
 * installer mid-migration; with an in-place data rewrite in the pipeline
 * that is no longer tolerable.) Takeover happens only when the recorded PID
 * is dead, or the lock is unreadable AND older than STALE_LOCK_MS.
 */
export function acquireInstallLock(): LockAcquisition {
  mkdirSync(runDir(), { recursive: true });
  const body = newLockBody();
  try {
    writeFileSync(installLockPath(), body, { flag: 'wx' });
    return { ok: true, tookOver: false };
  } catch {
    const existing = readLockBody();
    if (existing && pidAlive(existing.pid)) {
      // Live owner (heartbeat keeps ts fresh, but liveness is authoritative).
      return { ok: false, tookOver: false, existingPid: existing.pid };
    }
    if (!existing) {
      // Unreadable lock: only age can justify takeover.
      try {
        const ageMs = Date.now() - statSync(installLockPath()).mtimeMs;
        if (ageMs < STALE_LOCK_MS) return { ok: false, tookOver: false };
      } catch { /* vanished mid-check — fall through to claim */ }
    }
    writeFileSync(installLockPath(), body);
    return { ok: true, tookOver: true, ...(existing ? { existingPid: existing.pid } : {}) };
  }
}

/** Refresh the lock's ts every minute so observers can see the owner is live
 *  even without PID visibility. Only rewrites a lock we still own. Returns a
 *  stop function; unref'd so it never keeps the installer alive. */
export function startInstallLockHeartbeat(): () => void {
  const t = setInterval(() => {
    try {
      const existing = readLockBody();
      if (existing && existing.pid === process.pid && existing.token === ownLockToken) {
        writeFileSync(installLockPath(), JSON.stringify({
          pid: process.pid, ts: Date.now(), token: ownLockToken,
        } satisfies LockBody));
      }
    } catch { /* best-effort */ }
  }, 60_000);
  t.unref();
  return () => clearInterval(t);
}

export function releaseInstallLock(): void {
  try {
    const existing = readLockBody();
    // PID + token must BOTH match — never unlink a successor's lock.
    if (existing && existing.pid === process.pid && existing.token === ownLockToken) {
      unlinkSync(installLockPath());
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function detectWsl(): boolean {
  if (process.env['WSL_DISTRO_NAME']) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

function canWrite(path: string): boolean {
  try { accessSync(path, fsConstants.W_OK); return true; } catch { return false; }
}

function checkPlatform(report: PreflightReport, opts: PreflightOptions): void {
  const os = opts.platform ?? osPlatform();
  const a = opts.arch ?? osArch();
  const isWsl = detectWsl();
  const supported =
    (os === 'linux' && (a === 'x64' || a === 'arm64')) ||
    (os === 'darwin' && (a === 'x64' || a === 'arm64')) ||
    (os === 'win32' && a === 'x64');

  report.platform = { os, arch: a, isWsl, ok: supported };
  if (!supported) {
    report.failures.push({
      check: 'platform',
      severity: 'FAIL',
      message: `Unsupported platform ${os}/${a}`,
      remediation: 'recall supports Linux x64/arm64, macOS x64/arm64, Windows x64.',
    });
  }
  if (isWsl && existsSync(join(homedir(), '.claude')) && process.env['CLAUDE_CONFIG_DIR'] === undefined) {
    // Heuristic: a Windows-host ~/.claude is not visible from inside WSL, so we
    // only warn that the installer configures the environment it runs in.
    report.warnings.push({
      check: 'platform.wsl',
      severity: 'WARN',
      message: 'Running under WSL — the installer configures the environment it is invoked in. Rerun under the other environment (Windows-native) to cover both.',
    });
  }
}

/** Read the running macOS product version (e.g. "13.5") via `sw_vers`, or null
 *  if it cannot be determined (non-macOS, sw_vers missing, spawn error). */
async function readMacosProductVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], { timeout: 5000, windowsHide: true });
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Compare two dotted versions on major.minor only. <0, 0, >0 like a comparator. */
function compareMajorMinor(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 2; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * macOS OS-version floor: the pinned b5300 llama.cpp binaries are built with an
 * LC_BUILD_VERSION minos of 14.0 (arm64) / 13.7 (x64), so an older macOS cannot
 * dlopen them and semantic embedding is impossible. Fail fast in pre-flight with
 * an actionable message instead of the cryptic mid-install `Binary validation
 * failed` that `ensureBinary()` would otherwise surface. Non-macOS is a no-op.
 * If the version can't be read, degrade to a WARN (never crash the installer).
 */
async function checkMacosFloor(report: PreflightReport, opts: PreflightOptions): Promise<void> {
  const os = opts.platform ?? osPlatform();
  if (os !== 'darwin') return;

  const a = opts.arch ?? osArch();
  const { MACOS_MIN_VERSION } = await import('../recall/embedder.js');
  const floor = a === 'arm64' ? MACOS_MIN_VERSION.arm64 : MACOS_MIN_VERSION.x64;

  const version = opts.macosProductVersion
    ? await opts.macosProductVersion()
    : await readMacosProductVersion();

  if (!version) {
    report.warnings.push({
      check: 'platform.macos-version',
      severity: 'WARN',
      message: 'Could not determine the macOS version (sw_vers unavailable) — skipping the minimum-OS check for the bundled llama.cpp binaries.',
    });
    return;
  }

  if (compareMajorMinor(version, floor) < 0) {
    report.failures.push({
      check: 'platform.macos-version',
      severity: 'FAIL',
      message:
        `macOS ${version} is below the minimum for recall's bundled llama.cpp binaries ` +
        `(needs ${MACOS_MIN_VERSION.arm64}+ on Apple Silicon, ${MACOS_MIN_VERSION.x64}+ on Intel). ` +
        'Semantic embedding cannot run.',
      remediation: `Upgrade macOS to ${floor} or newer to install recall.`,
    });
  }
}

function checkClaude(report: PreflightReport): void {
  const dir = claudeDir();
  const settings = claudeSettingsPath();
  const skills = claudeSkillsDir();
  const skillFile = claudeRecallSkillPath();
  const paths = { dir, settings, skills, skillFile, claudeMd: claudeMdPath() };

  let ok = true;
  let status = 'ready';
  let existingHooks = 0;

  if (!existsSync(dir)) {
    ok = false;
    status = 'missing';
    report.failures.push({
      check: 'claude.dir',
      severity: 'FAIL',
      message: `~/.claude not found at ${dir}`,
      remediation: 'Install Claude Code first, or set CLAUDE_CONFIG_DIR.',
    });
    report.claude = { ok, status, paths, existingHooks, existingInstall: existsSync(recallRoot()) };
    return;
  }

  if (existsSync(settings)) {
    try {
      const parsed = JSON.parse(readFileSync(settings, 'utf-8'));
      const stop = parsed?.hooks?.Stop;
      const subStop = parsed?.hooks?.SubagentStop;
      existingHooks = (Array.isArray(stop) ? stop.length : 0) + (Array.isArray(subStop) ? subStop.length : 0);
      if (!canWrite(settings)) {
        report.warnings.push({ check: 'claude.settings.writable', severity: 'WARN', message: `${settings} is not writable — hook merge may fail.` });
      }
    } catch {
      report.warnings.push({ check: 'claude.settings.parse', severity: 'WARN', message: `${settings} is not valid JSON — will attempt fault-tolerant merge.` });
    }
  } else {
    status = 'fresh';
    report.warnings.push({ check: 'claude.settings', severity: 'WARN', message: 'No settings.json — will create one.' });
  }

  if (!existsSync(skills)) {
    report.warnings.push({ check: 'claude.skills', severity: 'WARN', message: 'skills/ absent — will create it.' });
  }
  if (existsSync(skillFile)) {
    report.warnings.push({ check: 'claude.recall-skill', severity: 'WARN', message: 'recall skill present — will back up + overwrite.' });
  }

  report.claude = { ok, status, paths, existingHooks, existingInstall: existsSync(recallRoot()) };
}

function checkCodex(report: PreflightReport): void {
  const dir = codexDir();
  if (!existsSync(dir)) {
    report.codex = null; // not installed → skip Codex setup entirely
    return;
  }
  const hooks = codexHooksPath();
  const agents = codexAgentsPath();
  const paths = { dir, hooks, agents };
  let ok = true;
  let status = 'ready';
  if (existsSync(hooks) && !canWrite(hooks)) {
    ok = false;
    status = 'hooks-readonly';
    report.warnings.push({
      check: 'codex.hooks.writable',
      severity: 'WARN',
      message: `${hooks} is not writable — Codex hook setup may fail.`,
    });
  }
  report.codex = { ok, status, paths };
}

function checkDisk(): { disk: string; issue?: PreflightIssue } {
  try {
    const base = existsSync(recallRoot()) ? recallRoot() : homedir();
    const st = statfsSync(base);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const freeMb = Math.floor(freeBytes / (1024 * 1024));
    const disk = `${freeMb} MB free`;
    if (freeMb < 200) {
      return { disk, issue: { check: 'runtime.disk', severity: 'FAIL', message: `Only ${freeMb} MB free at ${base} — need ≥200 MB (≥500 MB recommended).` } };
    }
    if (freeMb < 500) {
      return { disk, issue: { check: 'runtime.disk', severity: 'WARN', message: `${freeMb} MB free — recommended ≥500 MB (GPU staging adds ~180 MB on Linux).` } };
    }
    return { disk };
  } catch {
    return { disk: 'unknown' };
  }
}

function checkNode(): { node: string; issue?: PreflightIssue } {
  const node = process.version;
  const major = parseInt(node.replace(/^v/, '').split('.')[0] ?? '0', 10);
  if (major < 20) {
    return { node, issue: { check: 'runtime.node', severity: 'FAIL', message: `Node ${node} < 20 is unsupported (package.json engines requires Node ≥20).`, remediation: 'Upgrade to Node ≥20.' } };
  }
  return { node };
}

function httpReachable(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) > 0);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function checkNetwork(offline: boolean): Promise<{ network: string; issue?: PreflightIssue }> {
  if (offline) {
    // Verify pre-staged artifacts instead of hitting the network.
    const { getBinaryPath, getModelPath } = await import('../recall/embedder.js');
    const haveBin = existsSync(getBinaryPath());
    const haveModel = existsSync(getModelPath());
    if (haveBin && haveModel) return { network: 'offline (pre-staged binary + model present)' };
    if (haveBin || haveModel) return { network: 'offline (partial staging)', issue: { check: 'runtime.offline', severity: 'WARN', message: 'Offline mode: only part of the binary/model is pre-staged.' } };
    return { network: 'offline (nothing staged)', issue: { check: 'runtime.offline', severity: 'FAIL', message: 'Offline mode but neither binary nor model is pre-staged.', remediation: 'Pre-stage ~/.recall/bin/llama-embedding and the model, or drop --offline.' } };
  }
  const [hf, gh] = await Promise.all([
    httpReachable('https://huggingface.co', 4000),
    httpReachable('https://github.com', 4000),
  ]);
  if (hf && gh) return { network: 'reachable' };
  return { network: 'unreachable', issue: { check: 'runtime.network', severity: 'FAIL', message: 'HuggingFace and/or llama.cpp release hosts unreachable.', remediation: 'Check connectivity, or re-run with --offline after pre-staging artifacts.' } };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Run the full pre-flight suite. Never throws; collects warnings + failures. */
export async function runPreflight(opts: PreflightOptions = {}): Promise<PreflightReport> {
  const report: PreflightReport = {
    platform: { os: '', arch: '', isWsl: false, ok: false },
    claude: { ok: false, status: '', paths: {}, existingHooks: 0, existingInstall: false },
    codex: null,
    runtime: { node: '', disk: '', network: '', binaryArch: '', gpu: { detected: false, vendor: 'none', cudaAvailable: 'none', plannedMode: 'cpu' } },
    warnings: [],
    failures: [],
  };

  checkPlatform(report, opts);
  await checkMacosFloor(report, opts);
  checkClaude(report);
  checkCodex(report);

  const node = checkNode();
  report.runtime.node = node.node;
  if (node.issue) (node.issue.severity === 'FAIL' ? report.failures : report.warnings).push(node.issue);

  const disk = checkDisk();
  report.runtime.disk = disk.disk;
  if (disk.issue) (disk.issue.severity === 'FAIL' ? report.failures : report.warnings).push(disk.issue);

  const net = await checkNetwork(opts.offline ?? false);
  report.runtime.network = net.network;
  if (net.issue) (net.issue.severity === 'FAIL' ? report.failures : report.warnings).push(net.issue);

  report.runtime.binaryArch = `${opts.platform ?? osPlatform()}/${opts.arch ?? osArch()}`;

  // GPU detection (report-only — never a FAIL).
  report.runtime.gpu = await detectGpu({
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.arch ? { arch: opts.arch } : {}),
    ...(opts.gpuDetect ? { detect: opts.gpuDetect } : {}),
  });

  // Concurrent-install detection (read-only — install.ts acquires the lock).
  // Liveness is authoritative: a live owner blocks regardless of age.
  const existing = readLockBody();
  if (existing && pidAlive(existing.pid)) {
    report.failures.push({ check: 'install.lock', severity: 'FAIL', message: `Another install is running (PID ${existing.pid}).` });
  } else if (existing) {
    report.warnings.push({ check: 'install.lock', severity: 'WARN', message: 'Stale install lock found — will take over.' });
  }

  return report;
}

/** Convenience: a clean report has no FAIL entries. */
export function preflightPassed(report: PreflightReport): boolean {
  return report.failures.length === 0;
}
