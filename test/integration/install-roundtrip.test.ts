/**
 * install-roundtrip — full offline install then uninstall (§7).
 *
 * Runs `runInstall({ yes, offline })` in-process against a sandboxed $HOME
 * (RECALL_HOME via _setTestRoot, CLAUDE_CONFIG_DIR for ~/.claude), with the
 * binary/model/bundles pre-staged so no real downloads happen and the GPU is
 * forced absent. Then reverses it with runUninstall and asserts a clean state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, binDir, modelsDir, dbPath } from '../../src/paths.js';
import { _resetDb } from '../../src/db.js';
import { runInstall } from '../../src/installer/install.js';
import { runUninstall } from '../../src/installer/uninstall.js';
import { readConfig } from '../../src/installer/config.js';

let recallHome: string;
let claudeDir: string;
let distDir: string;
let restore: () => void;
let prevClaude: string | undefined;
let prevCodex: string | undefined;

function recallEntries(arr: any[]): any[] {
  return (arr ?? []).filter((e) => e.hooks?.some((h: any) => /stop-hook\.js/.test(h.command) && /recall/.test(h.command)));
}

beforeAll(() => {
  const sandbox = mkdtempSync(join(tmpdir(), 'recall-install-'));
  recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  distDir = join(sandbox, 'dist');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  // Dummy dist bundles (the detached backfill child just `node`s recall.js).
  for (const b of ['recall.js', 'stop-hook.js', 'embed-pending.js']) {
    writeFileSync(join(distDir, b), 'process.exit(0);\n');
  }

  // Pre-stage the offline runtime (binary + model) so step 4 is a no-op.
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(join(recallHome, 'models'), { recursive: true });

  restore = _setTestRoot(recallHome);
  writeFileSync(join(binDir(), 'llama-embedding'), 'dummy');
  writeFileSync(join(modelsDir(), 'nomic-embed-text-v1.5.Q8_0.gguf'), 'dummy-model');

  // Pre-seed existing Claude hooks to prove they survive.
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /pre/existing.js' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me' }] }],
    },
  }, null, 2));

  prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  prevCodex = process.env['CODEX_HOME'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = join(sandbox, '.codex-absent');
  _resetDb();
});

afterAll(() => {
  restore?.();
  _resetDb();
  if (prevClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prevClaude;
  if (prevCodex === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = prevCodex;
  const sandbox = join(recallHome, '..');
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

describe('install-roundtrip', () => {
  it('installs offline then uninstalls cleanly', async () => {
    const res = await runInstall({ yes: true, offline: true, distDir, gpuDetect: async () => false });
    expect(res.aborted).toBeFalsy();

    // ~/.recall scaffold
    for (const sub of ['bin', 'models', 'run', 'logs', 'recall.db']) {
      expect(existsSync(join(recallHome, sub))).toBe(true);
    }

    // config.json — CPU in the offline sandbox (no GPU libs staged)
    expect(readConfig()?.embedder.mode).toBe('cpu');

    // skill installed with $RECALL_BIN substituted to the RUNNABLE form
    const skillPath = join(claudeDir, 'skills', 'recall', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, 'utf-8');
    // Runnable is the pinned-node form: `"<execPath>" "<binDir>/recall.js"`.
    const runnable = `"${process.execPath}" "${join(binDir(), 'recall.js')}"`;
    expect(skill).toContain(runnable);
    expect(skill).not.toContain('$RECALL_BIN'); // fully substituted

    // settings.json: recall in BOTH Stop and SubagentStop, pre-seeded survives
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const stopRecall = recallEntries(settings.hooks.Stop);
    const subRecall = recallEntries(settings.hooks.SubagentStop);
    expect(stopRecall).toHaveLength(1);
    expect(subRecall).toHaveLength(1);
    expect(stopRecall[0].hooks[0].command).toContain(join(binDir(), 'stop-hook.js'));
    expect(settings.hooks.Stop.some((e: any) => e.hooks[0].command === 'node /pre/existing.js')).toBe(true);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('echo keep-me');

    // backup file written before the edit
    expect(readdirSync(claudeDir).some((f) => f.startsWith('settings.json.bak.'))).toBe(true);

    // backfill launched DETACHED by default (no foreground spinner blocked)
    expect(res.backfillPid).toBeTypeOf('number');
    expect(existsSync(join(recallHome, 'run', 'backfill.pid'))).toBe(true);

    // ---- uninstall ----
    const un = runUninstall({});
    expect(existsSync(join(claudeDir, 'skills', 'recall'))).toBe(false);
    const afterSettings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(recallEntries(afterSettings.hooks.Stop ?? [])).toHaveLength(0);
    expect(afterSettings.hooks.SubagentStop).toBeUndefined();
    // other hooks still present
    expect(afterSettings.hooks.Stop.some((e: any) => e.hooks[0].command === 'node /pre/existing.js')).toBe(true);
    expect(afterSettings.hooks.PreToolUse[0].hooks[0].command).toBe('echo keep-me');
    // ~/.recall intact (no --purge): DB + config survive
    expect(existsSync(dbPath())).toBe(true);
    expect(readConfig()?.embedder.mode).toBe('cpu');
    expect(un.purged).toBe(false);
  }, 30_000);
});
