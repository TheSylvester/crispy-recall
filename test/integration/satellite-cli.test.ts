/**
 * `dist/recall.js` on a satellite — forwarded queries (spec §3.4, D3).
 *
 * Spawns the real staged CLI against a stub hub and asserts the forwarding
 * contract: the guarded subcommands refuse without creating a database, the
 * scope flags are stripped and re-expressed in the body, stdout/stderr/exit
 * are relayed byte-identically, and every failure prints exactly ONE line.
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startStubHub, type StubHub, type StubHubOptions } from '../helpers/stub-hub.js';

const REPO = join(__dirname, '..', '..');
const CLI = join(REPO, 'dist', 'recall.js');

let sandbox: string;
let recallHome: string;
let claudeDir: string;
let codexDir: string;
let hub: StubHub;

interface RunOut { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], cwd = sandbox): Promise<RunOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        RECALL_HOME: recallHome,
        RECALL_REMOTE_ROOT: join(sandbox, 'remote'),
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: codexDir,
        RECALL_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function makeSatellite(url = hub.url, token = hub.token): void {
  mkdirSync(recallHome, { recursive: true });
  writeFileSync(join(recallHome, 'config.json'), JSON.stringify({
    satellite: { hubUrl: url, host: hub.host, installedAt: new Date().toISOString() },
  }, null, 2));
  writeFileSync(join(recallHome, 'satellite-token'), `${token}\n`, { mode: 0o600 });
}

function seedTranscript(cwd: string): string {
  const id = randomUUID();
  const dir = join(claudeDir, 'projects', '-tmp-cli');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${id}.jsonl`);
  writeFileSync(abs, `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd, message: { role: 'user', content: 'seeded' } })}\n`);
  return abs;
}

async function restartHub(opts: StubHubOptions): Promise<void> {
  await hub.close();
  hub = await startStubHub({ host: 'sat-cli', ...opts });
  makeSatellite();
}

const queryBody = () => hub.by('/v1/query').at(-1)!.json as { argv: string[]; cwd: string; key?: string };

beforeEach(async () => {
  hub = await startStubHub({ host: 'sat-cli', query: { stdout: 'HUB OUT\n', stderr: '', exit: 0 } });
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sat-cli-'));
  recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  codexDir = join(sandbox, '.codex');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  makeSatellite();
});

afterEach(async () => {
  rmSync(sandbox, { recursive: true, force: true });
  await hub.close();
});

describe('satellite CLI', () => {
  it('forwards a query with the wire headers on every request', async () => {
    seedTranscript(sandbox);
    const r = await runCli(['what did I do']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('HUB OUT\n');
    for (const req of hub.requests) {
      expect(req.headers['x-recall-wire']).toBe('1');
      expect(req.headers['x-recall-version']).toBeDefined();
    }
    expect(hub.by('/v1/query')).toHaveLength(1);
  });

  it('sends {argv, cwd, key} and strips --project / --project-key from argv', async () => {
    const r = await runCli(['find me', '--project', '/x/one', '--project-key', 'git:' + 'a'.repeat(40)]);
    expect(r.code).toBe(0);
    const body = queryBody();
    expect(body.cwd).toBe('/x/one');
    expect(body.key).toBeTruthy();
    expect(body.argv).toEqual(['find me']);
    expect(body.argv).not.toContain('--project');
    expect(body.argv).not.toContain('--project-key');
  });

  it('defaults the scope to the cwd and forwards no scope flags', async () => {
    await runCli(['plain query']);
    const body = queryBody();
    expect(body.cwd).toBe(sandbox);
    expect(body.argv).toEqual(['plain query']);
  });

  it('forwards date bounds and raw/recent search flags unchanged to the hub', async () => {
    const args = ['zebrafoo', '--since', '2024-01-01', '--until', '2024-12-31', '--raw-messages', '--recent'];
    expect((await runCli(args)).code).toBe(0);
    expect(queryBody().argv).toEqual(args);
  });

  it('passes --context through byte-identically (the hub strips it)', async () => {
    await runCli(['q', '--context', '5']);
    expect(queryBody().argv).toEqual(['q', '--context', '5']);
  });

  it('relays stdout, stderr and the exit code byte-identically', async () => {
    await restartHub({ query: { stdout: 'ünïcødé ✓\n', stderr: 'warn line\n', exit: 3 } });
    const r = await runCli(['q']);
    expect(r.stdout).toBe('ünïcødé ✓\n');
    expect(r.stderr).toContain('warn line');
    expect(r.code).toBe(3);
  });

  it('adds one line when the hub marks results stale', async () => {
    await restartHub({ query: { stdout: 'x', exit: 0, stale: true } });
    const r = await runCli(['q']);
    expect(r.stderr).toContain('recall: hub results may be stale');
  });

  it('warns about a version skew exactly once, even though it talks twice', async () => {
    seedTranscript(sandbox);
    await restartHub({ version: '9.9.9', query: { stdout: '', exit: 0 } });
    const r = await runCli(['q']);
    expect(hub.by('/v1/push/manifest').length).toBeGreaterThan(0);
    expect(hub.by('/v1/query')).toHaveLength(1);
    const skew = r.stderr.split('\n').filter((l) => l.includes('9.9.9'));
    expect(skew).toHaveLength(1);
  });

  it('flushes a changed transcript BEFORE forwarding the query', async () => {
    seedTranscript(sandbox);
    await runCli(['q']);
    const order = hub.requests.map((x) => x.path);
    expect(order.indexOf('/v1/push/append')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('/v1/push/append')).toBeLessThan(order.indexOf('/v1/query'));
  });

  it.each([['backfill', []], ['repair', ['--fts']], ['hub', ['status']]] as const)(
    'refuses `%s` with exit 1 and creates no database', async (cmd, extra) => {
      const r = await runCli([cmd, ...extra]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`recall ${cmd}: not available in satellite mode`);
      expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
    },
  );

  it('prints one line and exits 2 when the hub is unreachable', async () => {
    const url = hub.url;
    await hub.close();
    makeSatellite(url, 'irrelevant');
    const r = await runCli(['q']);
    expect(r.code).toBe(2);
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('recall: hub'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('unreachable');
    hub = await startStubHub(); // afterEach closes something valid
  });

  it('prints one line and exits 2 on a 401', async () => {
    makeSatellite(hub.url, 'not-the-token');
    const r = await runCli(['q']);
    expect(r.code).toBe(2);
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('recall: hub'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/replied 401/);
  });

  it('never escalates the pre-query flush to a full sweep, even on fullSweepDue', async () => {
    // S15: the hub asks for a full manifest at least once per 24 h. Answering
    // it inside an interactive query would re-enumerate every transcript; the
    // detached pusher answers it instead (S6, §3.4 "recent set only").
    await restartHub({ fullSweepDue: true, query: { stdout: 'OK\n', exit: 0 } });
    const stale = seedTranscript(sandbox);
    const ts = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    utimesSync(stale, ts, ts);
    const r = await runCli(['q']);
    expect(r.code).toBe(0);
    expect(hub.by('/v1/query')).toHaveLength(1);
    expect(hub.by('/v1/push/append')).toHaveLength(0);
    for (const m of hub.by('/v1/push/manifest')) expect((m.json as { full: boolean }).full).toBe(false);
  });

  it('gives up the flush on its own budget and still forwards the query', async () => {
    await restartHub({ manifestDelayMs: 10_000, query: { stdout: 'OK\n', exit: 0 } });
    seedTranscript(sandbox);
    const started = Date.now();
    const r = await runCli(['q']);
    const elapsed = Date.now() - started;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('OK\n');
    expect(hub.by('/v1/query')).toHaveLength(1);
    expect(elapsed).toBeLessThan(9000);
  }, 30_000);

  it('prints the satellite help', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('satellite of');
    expect(r.stdout).toContain('push [--full]');
    expect(r.stdout).toContain('--hub URL');
    expect(r.stdout).not.toContain('BACKFILL FLAGS');
  });

  it('`push --full` sends full manifests and exits 0', async () => {
    seedTranscript(sandbox);
    const r = await runCli(['push', '--full']);
    expect(r.code).toBe(0);
    const manifests = hub.by('/v1/push/manifest');
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) expect((m.json as { full: boolean }).full).toBe(true);
    expect(hub.by('/v1/query')).toHaveLength(0);
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });

  it('works with no better_sqlite3.node anywhere under the satellite root', async () => {
    seedTranscript(sandbox);
    expect(existsSync(join(recallHome, 'bin', 'better_sqlite3.node'))).toBe(false);
    for (const args of [['q'], ['push'], ['--help'], ['status'], ['doctor', '--integrity']]) {
      const r = await runCli(args);
      expect([0, 2], `recall ${args.join(' ')}`).toContain(r.code);
    }
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });
});
