/**
 * install-statusline-lifecycle — the statusLine feature ACROSS installs.
 *
 * Proves the upgrade-shaped guarantees end-to-end:
 *  - plain `--yes` re-install HEALS a previously-enabled statusline's stale
 *    node pin (persisted opt-in keeps the manifest item selected), and
 *    refreshes the config record's command corroboration
 *  - plain `--yes` re-install backs off a user-REPLACED statusline quietly
 *    and clears the record (doctor stops warning, nothing re-selects it)
 *  - `--no-statusline` is a true off: removes recall's own statusLine + the
 *    record, and never removes a foreign one
 *
 * Each test hand-crafts the "previously installed" state (config.json record +
 * settings.json statusLine — plain files) and then runs exactly ONE real
 * runInstall. Chaining two full runInstalls in one vitest fork segfaults the
 * native better-sqlite3 worker (pre-existing fragility; the product code path
 * is fine outside vitest), so the first install is simulated, not run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, binDir, modelsDir, statuslineScript } from '../../src/paths.js';
import { _resetDb } from '../../src/db.js';
import { runInstall } from '../../src/installer/install.js';
import { readConfig } from '../../src/installer/config.js';
import { stableNodePath } from '../../src/installer/stable-node.js';

let sandbox: string;
let claudeDir: string;
let distDir: string;
let restore: (() => void) | undefined;
const prev: Record<string, string | undefined> = {};

const FOREIGN = 'python3 ~/.claude/statusline.py';
function settingsFile(): string { return join(claudeDir, 'settings.json'); }
function readSettings(): any { return JSON.parse(readFileSync(settingsFile(), 'utf-8')); }
/** The exact command phase 7 writes/heals to in this sandbox. */
function recallCmd(): string { return `"${stableNodePath()}" "${statuslineScript()}"`; }

/** Simulate a prior `install --statusline`: the persisted opt-in record plus a
 *  wired settings.json — the two files a real first install would leave. */
function simulatePriorOptIn(settingsCommand: string): void {
  writeFileSync(join(sandbox, '.recall', 'config.json'), JSON.stringify({
    statusline: { installed: true, command: recallCmd(), priorStatusLine: null, installedAt: '2026-01-01T00:00:00.000Z' },
  }, null, 2));
  writeFileSync(settingsFile(), JSON.stringify({
    statusLine: { type: 'command', command: settingsCommand },
  }, null, 2));
}

function stageEnv(): void {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sl-lifecycle-'));
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

/** Capture everything the installer writes to stderr (the log()/say() sink). */
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

describe('install-statusline-lifecycle', () => {
  it('plain --yes install HEALS a previously-enabled statusline (stale node pin)', async () => {
    // A node upgrade left the pinned node in settings.json stale (same owned
    // script, drifted interpreter) — the exact 0.2.1 macOS bug class.
    simulatePriorOptIn(`"/old/gone/node" "${statuslineScript()}"`);

    // Plain --yes upgrade: NO --statusline flag. The persisted config record
    // keeps the manifest item selected, so phase 7 heals the pin like the Stop hook.
    const res = await install();
    expect(res.aborted).toBeFalsy();
    expect(readSettings().statusLine.command).toBe(recallCmd());
    // ...and the record's command corroboration was refreshed to match.
    expect(readConfig()?.statusline?.command).toBe(recallCmd());
    expect(readConfig()?.statusline?.installed).toBe(true);
  }, 30_000);

  it('plain --yes install respects a user-DELETED statusline: no resurrection, record cleared', async () => {
    // User opted in earlier, then deliberately deleted the statusLine key from
    // settings.json. A plain upgrade must NOT re-wire it (that would resurrect
    // a removed feature) — it must clear the record, exactly as doctor promises.
    writeFileSync(join(sandbox, '.recall', 'config.json'), JSON.stringify({
      statusline: { installed: true, command: recallCmd(), priorStatusLine: null, installedAt: '2026-01-01T00:00:00.000Z' },
    }, null, 2));
    writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark' }, null, 2));

    const res = await install();
    expect(res.aborted).toBeFalsy();
    expect(readSettings().statusLine).toBeUndefined();   // NOT resurrected
    expect(readConfig()?.statusline).toBeUndefined();    // record cleared
  }, 30_000);

  it('plain --yes install backs off a user-replaced statusline and clears the record', async () => {
    // User replaced recall's statusline with their own after opting in.
    simulatePriorOptIn(FOREIGN);

    const { result: res, out } = await withStderr(() => install());
    expect((res as { aborted?: boolean }).aborted).toBeFalsy();
    expect(readSettings().statusLine.command).toBe(FOREIGN);   // untouched
    expect(readConfig()?.statusline).toBeUndefined();          // record reconciled away
    // Persisted-only path must NOT spam the full Option A/B guidance on every upgrade.
    expect(out).not.toContain('── Option A');
  }, 30_000);

  it('--no-statusline is a true off: removes recall\'s statusLine and the record', async () => {
    simulatePriorOptIn(recallCmd());

    const res = await install({ noStatusline: true });
    expect(res.aborted).toBeFalsy();
    expect(readSettings().statusLine).toBeUndefined();
    expect(readConfig()?.statusline).toBeUndefined();
  }, 30_000);

  it('--no-statusline never removes a FOREIGN statusline', async () => {
    // No prior record; the user has their own statusline.
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: 'command', command: FOREIGN } }, null, 2));

    const res = await install({ noStatusline: true });
    expect(res.aborted).toBeFalsy();
    expect(readSettings().statusLine.command).toBe(FOREIGN);
  }, 30_000);
});
