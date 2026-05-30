/**
 * manifest-optout — the upfront MANDATORY-vs-OPT-OUT contract (§7).
 *
 * Asserts the manifest tags GPU/stop-hook/skill/backfill as MANDATORY and the
 * CLAUDE.md nudge as the only OPT-OUT item, and that --no-claudemd skips ONLY
 * that item while mandatory items still land.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { readConfig } from '../../src/installer/config.js';

let recallHome: string;
let claudeDir: string;
let distDir: string;
let sandbox: string;
let restore: () => void;
let prevClaude: string | undefined;
let prevCodex: string | undefined;

function claudeMd(): string { return join(claudeDir, 'CLAUDE.md'); }
function settingsFile(): string { return join(claudeDir, 'settings.json'); }
function skillFile(): string { return join(claudeDir, 'skills', 'recall', 'SKILL.md'); }

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-manifest-'));
  recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  distDir = join(sandbox, 'dist');
  mkdirSync(claudeDir, { recursive: true }); // empty ~/.claude
  mkdirSync(distDir, { recursive: true });
  for (const b of ['recall.js', 'stop-hook.js', 'embed-pending.js']) writeFileSync(join(distDir, b), 'process.exit(0);\n');
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(join(recallHome, 'models'), { recursive: true });

  restore = _setTestRoot(recallHome);
  writeFileSync(join(binDir(), 'llama-embedding'), 'dummy');
  writeFileSync(join(modelsDir(), 'nomic-embed-text-v1.5.Q8_0.gguf'), 'dummy');

  prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  prevCodex = process.env['CODEX_HOME'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  process.env['CODEX_HOME'] = join(sandbox, '.codex-absent');
});

beforeEach(() => { _resetDb(); });

afterAll(() => {
  restore?.();
  _resetDb();
  if (prevClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prevClaude;
  if (prevCodex === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = prevCodex;
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

describe('manifest-optout', () => {
  it('tags mandatory vs opt-out correctly', async () => {
    const report = await runPreflight({ offline: true, gpuDetect: async () => false });
    const manifest = buildManifest(report);
    const by = (k: string) => manifest.find((i) => i.key === k)!;

    for (const k of ['gpu', 'stop-hook', 'skill', 'backfill']) {
      expect(by(k).mandatory, `${k} should be mandatory`).toBe(true);
    }
    expect(by('claudemd').mandatory).toBe(false);
    expect(by('claudemd').defaultSelected).toBe(true);
    // empty ~/.codex → no codex rows
    expect(manifest.find((i) => i.key.startsWith('codex'))).toBeUndefined();
  });

  it('applies the opt-out CLAUDE.md nudge by default under --yes', async () => {
    if (existsSync(claudeMd())) rmSync(claudeMd());
    const res = await runInstall({ yes: true, offline: true, distDir, gpuDetect: async () => false });
    expect(res.aborted).toBeFalsy();
    expect(readFileSync(claudeMd(), 'utf-8')).toMatch(/^## Recall$/m);
  });

  it('--no-claudemd skips ONLY the nudge; mandatory items still land', async () => {
    if (existsSync(claudeMd())) rmSync(claudeMd());
    const res = await runInstall({ yes: true, offline: true, distDir, noClaudemd: true, gpuDetect: async () => false });
    expect(res.aborted).toBeFalsy();

    // opt-out skipped
    const md = existsSync(claudeMd()) ? readFileSync(claudeMd(), 'utf-8') : '';
    expect(md).not.toContain('## Recall');

    // mandatory items still applied — Stop hook, skill, config (no flag can skip these)
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf-8'));
    expect(settings.hooks.Stop.length).toBeGreaterThan(0);
    expect(settings.hooks.SubagentStop.length).toBeGreaterThan(0);
    expect(existsSync(skillFile())).toBe(true);
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });
});
