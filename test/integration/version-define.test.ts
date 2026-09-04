/**
 * Build-time version define (spec §6).
 *
 * `scripts/build.mjs` substitutes `__RECALL_VERSION__`, so a STAGED bundle —
 * one copied away from the repo, with no sibling `package.json` — reports the
 * real version instead of `unknown`. That is what every hook, daemon and
 * satellite runs.
 *
 * Isolation — in-process: every new suite that calls `runInstall`, `runDoctor`,
 * `getStatus`, `runUninstall` or `runPreflight` IN-PROCESS MUST first call
 * `restore = _setTestRoot(join(<tmp>, '.recall'))` (restore it in
 * afterAll/afterEach) AND set `process.env.CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
 * `RECALL_REMOTE_ROOT` to temp dirs (restoring the previous values), exactly as
 * test/unit/preflight-node-version.test.ts:25-38 and
 * test/integration/manifest-optout.test.ts:33-54 do; without it `recallRoot()`
 * resolves to the owner's LIVE `~/.recall` (paths.ts:33-40).
 * Isolation — spawned children: `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getVersion } from '../../src/version.js';
import { startStubHub, type StubHub } from '../helpers/stub-hub.js';

const ROOT = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-ver-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Spawn a staged bundle copy with a fully isolated recall root. */
function runStaged(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = join(tmp, 'home');
  const child = spawn(process.execPath, [file, ...args], {
    env: {
      ...process.env,
      RECALL_HOME: home,
      RECALL_REMOTE_ROOT: join(home, 'remote'),
      CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
      CODEX_HOME: join(tmp, 'codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  return new Promise((res) => {
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

describe('build-time version define', () => {
  it('is testing a FRESH dist/ — the define is baked at build time', () => {
    expect(
      existsSync(join(ROOT, 'dist', 'recall.js')),
      'dist/recall.js is missing — run `npm run build`',
    ).toBe(true);
    expect(
      readFileSync(join(ROOT, 'dist', 'recall.js'), 'utf8'),
      'dist is stale — run `npm run build` (the version define is baked at build time)',
    ).toContain(JSON.stringify(pkg.version));
  });

  it('a STAGED dist/recall.js prints the package version, not "unknown"', async () => {
    const staged = join(tmp, 'recall.js');
    expect(existsSync(join(ROOT, 'dist', 'recall.js'))).toBe(true);
    cpSync(join(ROOT, 'dist', 'recall.js'), staged);
    // No package.json anywhere above `tmp` belongs to crispy-recall, so only
    // the define can supply the answer.
    const r = await runStaged(staged, ['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).not.toBe('unknown');
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('carries the define into the satellite bundle and keeps it addon-free', () => {
    const bundle = readFileSync(join(ROOT, 'dist', 'push-pending.js'), 'utf8');
    // push-pending.js has no --version flag (it parses only --named/--hook/
    // --cwd/--full), so assert the substituted literal directly.
    expect(bundle).toContain(JSON.stringify(pkg.version));
    expect(bundle).not.toContain('better_sqlite3');
  });

  it('falls back to package.json when there is no define (vitest)', () => {
    expect(getVersion()).toBe(pkg.version);
    expect(getVersion()).not.toBe('unknown');
  });

  it('the stub hub answers with the package version by default', async () => {
    let hub: StubHub | undefined;
    try {
      hub = await startStubHub();
      const res = await fetch(`${hub.url}/v1/health`);
      expect(res.headers.get('x-recall-version')).toBe(pkg.version);
      const body = (await res.json()) as { version?: string };
      expect(body.version).toBe(pkg.version);
    } finally {
      await hub?.close();
    }
  });
});
