/**
 * `recall install --hub …` — the satellite install roundtrip (spec §3.1).
 *
 * Runs the real installer against a stub hub at a temp root and asserts the
 * defining negative: NO database, NO model directory, NO native addon and NO
 * embed-pending bundle are ever created on a satellite — plus the positives
 * (four bundles, config record, 0600 token, hooks, the retention table, and
 * the detached `push-pending.js --full`).
 *
 * Isolation — in-process: every new suite that calls `runInstall`, `runDoctor`,
 * `getStatus`, `runUninstall` or `runPreflight` IN-PROCESS MUST first call
 * `restore = _setTestRoot(join(<tmp>, '.recall'))` (restore it in
 * afterAll/afterEach) AND set `process.env.CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
 * `RECALL_REMOTE_ROOT` to temp dirs (restoring the previous values), exactly as
 * test/unit/preflight-node-version.test.ts:25-38 and
 * test/integration/manifest-optout.test.ts:33-54 do; without it `recallRoot()`
 * resolves to the owner's LIVE `~/.recall` (paths.ts:33-40): a satellite
 * `runInstall` would write a `satellite` key into the live config.json and
 * `runUninstall` would delete the live skill and strip the live Stop hooks.
 * Isolation — spawned children: `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`. The installer
 * itself spawns the initial push, so RECALL_HOME is exported here too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import { runInstall } from '../../src/installer/install.js';
import { readConfig } from '../../src/installer/config.js';
import { startStubHub, type StubHub } from '../helpers/stub-hub.js';

const REPO = join(__dirname, '..', '..');

let sandbox: string;
let recallHome: string;
let claudeDir: string;
let codexDir: string;
let distDir: string;
let restore: () => void;
let hub: StubHub;
const prevEnv: Record<string, string | undefined> = {};

/** A recorder in place of the real push-pending bundle: it writes its argv so
 *  the test can prove the initial push was launched with `--full`. */
function stagePushRecorder(target: string, argvFile: string): void {
  writeFileSync(
    target,
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
}

function setEnv(k: string, v: string): void {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(async () => {
  hub = await startStubHub({ host: 'sat-install' });
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sat-install-'));
  recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  codexDir = join(sandbox, '.codex-absent');
  distDir = join(sandbox, 'dist');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  for (const b of ['recall.js', 'stop-hook.js', 'statusline.js', 'embed-pending.js']) {
    writeFileSync(join(distDir, b), 'process.exit(0);\n');
  }
  writeFileSync(join(distDir, 'SKILL.md.template'), '# recall\n\nRun $RECALL_BIN "query".\n');
  stagePushRecorder(join(distDir, 'push-pending.js'), join(sandbox, 'push-argv.json'));

  restore = _setTestRoot(recallHome);
  setEnv('RECALL_HOME', recallHome);
  setEnv('CLAUDE_CONFIG_DIR', claudeDir);
  setEnv('CODEX_HOME', codexDir);
  setEnv('RECALL_REMOTE_ROOT', join(sandbox, 'remote'));
  delete process.env['RECALL_HUB_TOKEN'];
});

afterEach(async () => {
  restore?.();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete prevEnv[k];
  }
  rmSync(sandbox, { recursive: true, force: true });
  await hub.close();
});

function install(over: Record<string, unknown> = {}) {
  return runInstall({
    hub: hub.url, token: hub.token, yes: true, noClaudemd: true, distDir,
    templatePath: join(distDir, 'SKILL.md.template'), ...over,
  });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('satellite install', () => {
  it('creates no database, model directory, native addon or embed-pending bundle', async () => {
    const res = await install();
    expect(res.aborted).toBeFalsy();
    expect(res.mode).toBe('satellite');
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
    expect(existsSync(join(recallHome, 'models'))).toBe(false);
    expect(existsSync(join(recallHome, 'bin', 'embed-pending.js'))).toBe(false);
    expect(walk(recallHome).filter((f) => f.endsWith('.node'))).toEqual([]);
    expect(existsSync(join(recallHome, 'bin', '.binding-info.json'))).toBe(false);
    for (const b of ['recall.js', 'stop-hook.js', 'push-pending.js', 'statusline.js']) {
      expect(existsSync(join(recallHome, 'bin', b)), b).toBe(true);
    }
    expect(res.gpu).toEqual({ mode: 'cpu', libDir: null, ngl: 0, cudaAvailable: 'none' });
  });

  it('records the hub URL and the host the hub reported', async () => {
    await install();
    expect(readConfig()?.satellite).toMatchObject({ hubUrl: hub.url, host: 'sat-install' });
  });

  it('writes the token 0600 and never echoes it', async () => {
    const out: string[] = [];
    const spyOut = process.stdout.write.bind(process.stdout);
    const spyErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown as (c: string) => boolean) = (c: string) => { out.push(String(c)); return true; };
    (process.stderr.write as unknown as (c: string) => boolean) = (c: string) => { out.push(String(c)); return true; };
    try {
      await install();
    } finally {
      process.stdout.write = spyOut;
      process.stderr.write = spyErr;
    }
    const tokenFile = join(recallHome, 'satellite-token');
    expect(readFileSync(tokenFile, 'utf-8').trim()).toBe(hub.token);
    if (process.platform !== 'win32') {
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    }
    expect(out.join('')).not.toContain(hub.token);
    expect(JSON.stringify(readConfig())).not.toContain(hub.token);
  });

  it('wires the Claude Stop hook, and the Codex hook when Codex is present', async () => {
    await install();
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(JSON.stringify(settings.hooks.Stop)).toContain('stop-hook.js');
    expect(JSON.stringify(settings.hooks.SubagentStop)).toContain('stop-hook.js');

    const codexHome = join(sandbox, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'hooks.json'), '{}');
    setEnv('CODEX_HOME', codexHome);
    await install();
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf-8')).toContain('stop-hook.js');
  });

  it.each([
    ['absent', undefined, 999],
    ['30', 30, 999],
    ['1000', 1000, 1000],
  ] as const)('retention: %s → %s', async (_label, initial, expected) => {
    const settings = join(claudeDir, 'settings.json');
    writeFileSync(settings, JSON.stringify(initial === undefined ? {} : { cleanupPeriodDays: initial }));
    await install();
    expect(JSON.parse(readFileSync(settings, 'utf-8')).cleanupPeriodDays).toBe(expected);
  });

  // Only the EXISTENCE of a backup is assertable at this level. The retention
  // pass and the hook merge both back up settings.json in the same run, and
  // `backupStamp()` is millisecond-resolution, so the second copy can land on
  // the first one's name — which content is preserved is then a race. The
  // exact backup-or-not table, and the pre-change contents, are asserted
  // deterministically in test/unit/settings-retention.test.ts.
  it('retention: raising the value leaves a settings.json backup behind', async () => {
    const settings = join(claudeDir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30 }));
    await install();
    expect(readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.bak.')).length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(settings, 'utf-8')).cleanupPeriodDays).toBe(999);
  });

  it('retention: a non-numeric value is left alone and warned about', async () => {
    const settings = join(claudeDir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 'abc' }));
    const res = await install();
    expect(JSON.parse(readFileSync(settings, 'utf-8')).cleanupPeriodDays).toBe('abc');
    expect(res.report.warnings.some((w) => w.check === 'claude.retention')).toBe(true);
  });

  it('launches the initial push with --full', async () => {
    const argvFile = join(sandbox, 'push-argv.json');
    await install();
    expect(await waitFor(() => existsSync(argvFile))).toBe(true);
    expect(JSON.parse(readFileSync(argvFile, 'utf-8'))).toEqual(['--full']);
  });

  it('aborts with hub.unreachable when the hub is down', async () => {
    const url = hub.url;
    await hub.close();
    const res = await runInstall({ hub: url, token: 'anything', yes: true, distDir });
    expect(res.aborted).toBe(true);
    expect(res.report.failures.some((f) => f.check === 'hub.unreachable')).toBe(true);
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
    hub = await startStubHub(); // afterEach closes something valid
  });

  it('aborts with hub.auth on a bad token', async () => {
    const res = await install({ token: 'wrong-token' });
    expect(res.aborted).toBe(true);
    expect(res.report.failures.some((f) => f.check === 'hub.auth')).toBe(true);
  });

  it('aborts with hub.auth naming the wire when the hub speaks another wire', async () => {
    const other = await startStubHub({ wire: 99 });
    try {
      const res = await runInstall({ hub: other.url, token: other.token, yes: true, distDir });
      expect(res.aborted).toBe(true);
      const f = res.report.failures.find((x) => x.check === 'hub.auth');
      expect(f?.message).toMatch(/426/);
      expect(f?.message).toMatch(/wire/);
    } finally {
      await other.close();
    }
  });

  it('a flagless re-install stays on the satellite path and reuses the stored hub', async () => {
    await install();
    const before = { hubUrl: readConfig()!.satellite!.hubUrl, host: readConfig()!.satellite!.host };
    const res = await runInstall({ yes: true, noClaudemd: true, distDir, templatePath: join(distDir, 'SKILL.md.template') });
    expect(res.mode).toBe('satellite');
    expect(res.aborted).toBeFalsy();
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
    expect(existsSync(join(recallHome, 'models'))).toBe(false);
    expect(walk(recallHome).filter((f) => f.endsWith('.node'))).toEqual([]);
    expect(readConfig()?.satellite).toMatchObject(before);
  });

  it('`--token -` reads one line from stdin (spawned CLI, own RECALL_HOME)', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [join(REPO, 'dist', 'recall.js'), 'install', '--hub', hub.url, '--token', '-', '--yes', '--no-claudemd'], {
        env: {
          ...process.env,
          RECALL_HOME: recallHome,
          RECALL_REMOTE_ROOT: join(sandbox, 'remote'),
          CLAUDE_CONFIG_DIR: claudeDir,
          CODEX_HOME: codexDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => { out += String(c); });
      child.stderr.on('data', (c) => { out += String(c); });
      child.on('error', reject);
      child.on('close', (c) => {
        expect(out).not.toContain(hub.token);
        resolve(c ?? 1);
      });
      child.stdin.write(`${hub.token}\n`);
      child.stdin.end();
    });
    expect(code).toBe(0);
    expect(readFileSync(join(recallHome, 'satellite-token'), 'utf-8').trim()).toBe(hub.token);
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });
});
