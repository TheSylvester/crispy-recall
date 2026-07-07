/**
 * install-statusline — the opt-in statusLine feature at install/uninstall level.
 *
 * Proves the load-bearing guarantees end-to-end against a temp HOME/RECALL_HOME:
 *  - default-off: `--yes` (no --statusline) NEVER touches statusLine
 *  - empty slot: `--statusline` writes recall's command + records config
 *  - foreign slot: `--statusline` leaves it unchanged (never clobbers)
 *  - re-apply: idempotent, never re-stashes recall's own command
 *  - uninstall: removes the recall statusLine (restore-or-delete)
 *
 * Each test stages a FRESH sandbox in beforeEach and tears it down in afterEach
 * (mirrors install-upgrade) — reopening the native better-sqlite3 DB against a
 * shared file across many installs segfaults the worker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, binDir, modelsDir } from '../../src/paths.js';
import { _resetDb } from '../../src/db.js';
import { runPreflight } from '../../src/installer/preflight.js';
import { buildManifest } from '../../src/installer/manifest.js';
import { runInstall } from '../../src/installer/install.js';
import { runUninstall } from '../../src/installer/uninstall.js';
import { readConfig } from '../../src/installer/config.js';
import { detectStatusline } from '../../src/installer/statusline-suggest.js';

let sandbox: string;
let claudeDir: string;
let distDir: string;
let restore: (() => void) | undefined;
const prev: Record<string, string | undefined> = {};

const FOREIGN = 'python3 ~/.claude/statusline.py';
function settingsFile(): string { return join(claudeDir, 'settings.json'); }
function readSettings(): any { return JSON.parse(readFileSync(settingsFile(), 'utf-8')); }

function stageEnv(): void {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sl-install-'));
  const recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  distDir = join(sandbox, 'dist');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  for (const b of ['recall.js', 'stop-hook.js', 'embed-pending.js', 'statusline.js']) {
    writeFileSync(join(distDir, b), 'process.exit(0);\n');
  }
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(join(recallHome, 'models'), { recursive: true });

  restore = _setTestRoot(recallHome);
  writeFileSync(join(binDir(), 'llama-embedding'), 'dummy');
  writeFileSync(join(modelsDir(), 'nomic-embed-text-v1.5.Q8_0.gguf'), 'dummy');

  prev['CLAUDE_CONFIG_DIR'] = process.env['CLAUDE_CONFIG_DIR'];
  prev['CODEX_HOME'] = process.env['CODEX_HOME'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = join(sandbox, '.codex-absent');
}

beforeEach(() => { stageEnv(); _resetDb(); });

afterEach(() => {
  restore?.(); restore = undefined;
  _resetDb();
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  }
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

const install = (opts: Record<string, unknown> = {}) =>
  runInstall({ yes: true, offline: true, distDir, noBackfill: true, gpuDetect: async () => false, ...opts });

/** Capture everything the installer writes to stderr (the log()/say() sink)
 *  while `fn` runs, so phase-7's printed guidance can be asserted. */
async function withStderr<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, out: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

describe('install-statusline', () => {
  it('manifest item is opt-in (defaultSelected:false)', async () => {
    const report = await runPreflight({ offline: true, gpuDetect: async () => false });
    const item = buildManifest(report).find((i) => i.key === 'statusline')!;
    expect(item).toBeDefined();
    expect(item.mandatory).toBe(false);
    expect(item.defaultSelected).toBe(false);
  });

  it('--yes WITHOUT --statusline never touches statusLine', async () => {
    const res = await install();
    expect(res.aborted).toBeFalsy();
    const s = readSettings();
    expect(s.statusLine).toBeUndefined();           // feature not enabled
    expect(s.hooks.Stop.length).toBeGreaterThan(0); // mandatory items still landed
    expect(readConfig()?.statusline).toBeUndefined();
  });

  it('--statusline into an empty slot writes recall command + records config', async () => {
    const res = await install({ statusline: true });
    expect(res.aborted).toBeFalsy();
    const cmd = readSettings().statusLine.command as string;
    expect(cmd).toContain('statusline.js');
    expect(cmd).toContain('.recall');
    const rec = readConfig()?.statusline;
    expect(rec?.installed).toBe(true);
    expect(rec?.command).toBe(cmd);
    expect(rec?.priorStatusLine).toBeNull();
  });

  it('--no-statusline wins over --statusline', async () => {
    const res = await install({ statusline: true, noStatusline: true });
    expect(res.aborted).toBeFalsy();
    expect(readSettings().statusLine).toBeUndefined();
  });

  it('--statusline leaves a FOREIGN statusLine unchanged (never clobbers) and prints both options', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: 'command', command: FOREIGN } }, null, 2));
    const { result: res, out } = await withStderr(() => install({ statusline: true }));
    expect(res.aborted).toBeFalsy();
    expect(readSettings().statusLine.command).toBe(FOREIGN);   // untouched
    expect(readConfig()?.statusline).toBeUndefined();          // not recorded (foreign)
    // phase-7 else-branch actually emitted the never-clobber guidance with BOTH options.
    expect(out).toContain("won't change your statusline");
    expect(out).toContain('── Option A');
    expect(out).toContain('── Option B');
  });

  it('re-running install --statusline is idempotent — heals in place, no re-stash, no custom-statusline message', async () => {
    // 1st install writes into the empty slot and records config.
    await install({ statusline: true });
    const firstCmd = readSettings().statusLine.command as string;
    expect(readConfig()?.statusline?.priorStatusLine).toBeNull();

    // A REAL second `install --statusline` drives the phase-7 recall-owned arm
    // through runInstall (not a manual mergeStatusLine). Reopening the native DB
    // in one test is safe with a _resetDb() between — install-upgrade's own
    // idempotency test does exactly this. The recall-owned slot heals in place;
    // it must NOT print the foreign "you already have a statusline" guidance and
    // must NOT re-stash recall's own command as a prior.
    _resetDb();
    const { out } = await withStderr(() => install({ statusline: true }));
    expect(readSettings().statusLine.command).toBe(firstCmd);      // unchanged
    expect(readConfig()?.statusline?.priorStatusLine).toBeNull();  // not re-stashed
    expect(out).not.toContain("won't change your statusline");     // no foreign message
    expect(detectStatusline(settingsFile()).kind).toBe('recall');  // still ours
  }, 30_000);

  it('uninstall removes the recall statusLine key AND clears the config record', async () => {
    await install({ statusline: true });
    expect(readSettings().statusLine).toBeDefined();
    runUninstall({});
    expect(readSettings().statusLine).toBeUndefined();
    // Stale record would make doctor warn forever and reinstalls re-select it.
    expect(readConfig()?.statusline).toBeUndefined();
  });

  it('manifest defaultSelected flips ON when config records a prior opt-in', async () => {
    await install({ statusline: true });
    const report = await runPreflight({ offline: true, gpuDetect: async () => false });
    const item = buildManifest(report).find((i) => i.key === 'statusline')!;
    expect(item.defaultSelected).toBe(true);
  });
});

// The upgrade-lifecycle tests (heal-on-plain-install, back-off-on-replaced,
// --no-statusline true-off) live in install-statusline-lifecycle.test.ts —
// they chain 2-3 full runInstalls each, and this worker already reopens the
// native DB enough times that adding them here segfaults the fork.
