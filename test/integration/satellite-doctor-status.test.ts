/**
 * `recall doctor` / `recall status` / `recall uninstall` on a satellite (§3.1).
 *
 * Doctor reports the hub link and the local things that decide whether a
 * transcript ever reaches it; status stays synchronous and local; uninstall
 * takes the bearer token with it. None of the three may open — or create — a
 * database, and doctor must not run `checkBindingHealth` (there is no addon).
 *
 * Isolation — in-process: every new suite that calls `runInstall`, `runDoctor`,
 * `getStatus`, `runUninstall` or `runPreflight` IN-PROCESS MUST first call
 * `restore = _setTestRoot(join(<tmp>, '.recall'))` (restore it in
 * afterAll/afterEach) AND set `process.env.CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
 * `RECALL_REMOTE_ROOT` to temp dirs (restoring the previous values), exactly as
 * test/unit/preflight-node-version.test.ts:25-38 and
 * test/integration/manifest-optout.test.ts:33-54 do; without it `recallRoot()`
 * resolves to the owner's LIVE `~/.recall` (paths.ts:33-40): `runUninstall`
 * would delete the live `~/.claude/skills/recall/` and strip the live Stop hooks.
 * Isolation — spawned children: `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _setTestRoot } from '../../src/paths.js';
import { runDoctor } from '../../src/installer/doctor.js';
import { getStatus } from '../../src/installer/status.js';
import { runUninstall } from '../../src/installer/uninstall.js';
import { startStubHub, type StubHub } from '../helpers/stub-hub.js';

let sandbox: string;
let recallHome: string;
let claudeDir: string;
let codexDir: string;
let restore: () => void;
let hub: StubHub;
const prevEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k];
  process.env[k] = v;
}

function makeSatellite(): void {
  mkdirSync(recallHome, { recursive: true });
  mkdirSync(join(recallHome, 'logs'), { recursive: true });
  writeFileSync(join(recallHome, 'config.json'), JSON.stringify({
    satellite: { hubUrl: hub.url, host: hub.host, installedAt: new Date().toISOString() },
  }, null, 2));
  writeFileSync(join(recallHome, 'satellite-token'), `${hub.token}\n`, { mode: 0o600 });
}

function seedTranscript(cwd: string): void {
  const id = randomUUID();
  const dir = join(claudeDir, 'projects', '-tmp-doc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd, message: { role: 'user', content: 'x' } })}\n`);
}

/** Capture console.log while `fn` runs. */
async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try {
    const code = await fn();
    return { code, out: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  hub = await startStubHub({ host: 'sat-doctor' });
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sat-doctor-'));
  recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  codexDir = join(sandbox, '.codex-absent');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 999 }));
  restore = _setTestRoot(recallHome);
  setEnv('RECALL_HOME', recallHome);
  setEnv('CLAUDE_CONFIG_DIR', claudeDir);
  setEnv('CODEX_HOME', codexDir);
  setEnv('RECALL_REMOTE_ROOT', join(sandbox, 'remote'));
  makeSatellite();
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

describe('satellite doctor / status / uninstall', () => {
  it('TABLE mode prints every required line and exits 0, with no DB and no binding check', async () => {
    seedTranscript(sandbox);
    const { code, out } = await captured(() => runDoctor({}));
    expect(code).toBe(0);
    for (const needle of ['hub reachable', 'auth ok', 'hub version', 'last push', 'pending bytes', 'git', 'cleanupPeriodDays']) {
      expect(out, needle).toContain(needle);
    }
    // The binding/embedder/GPU rows belong to a hub: on a satellite there is no
    // addon to check, so checkBindingHealth is never reached.
    for (const absent of ['Binding', 'binding', 'Embedder', 'GPU:']) {
      expect(out, absent).not.toContain(absent);
    }
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });

  it('JSON mode carries the same fields', async () => {
    seedTranscript(sandbox);
    const { code, out } = await captured(() => runDoctor({ json: true }));
    expect(code).toBe(0);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j).toMatchObject({ mode: 'satellite', hubUrl: hub.url, host: 'sat-doctor', hubReachable: true, authOk: true });
    for (const k of ['hubVersion', 'lastPush', 'pendingBytes', 'git', 'cleanupPeriodDays']) {
      expect(j, k).toHaveProperty(k);
    }
    expect(typeof j['pendingBytes']).toBe('number');
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });

  it('lists a file that failed each of the last three runs', async () => {
    const rel = 'projects/-tmp-doc/broken.jsonl';
    const lines = [1, 2, 3].map((i) =>
      `2026-09-0${i}T00:00:00.000Z push-failed host=sat-doctor vendor=claude path=${rel} err=boom`).join('\n');
    writeFileSync(join(recallHome, 'logs', 'push.log'), `${lines}\n`);
    const { out } = await captured(() => runDoctor({ json: true }));
    expect((JSON.parse(out) as { failingFiles: string[] }).failingFiles).toEqual([rel]);
  });

  it('warns when cleanupPeriodDays is below the floor', async () => {
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }));
    const { out } = await captured(() => runDoctor({ json: true }));
    const j = JSON.parse(out) as { cleanupPeriodDays: number; warnings: string[] };
    expect(j.cleanupPeriodDays).toBe(30);
    expect(j.warnings.some((w) => w.includes('cleanupPeriodDays'))).toBe(true);
  });

  it('reports the hub as unreachable and exits 1 when it is down', async () => {
    await hub.close();
    const { code, out } = await captured(() => runDoctor({ json: true }));
    expect(code).toBe(1);
    const j = JSON.parse(out) as { hubReachable: boolean; pendingBytes: number | null };
    expect(j.hubReachable).toBe(false);
    expect(j.pendingBytes).toBeNull();
    hub = await startStubHub(); // afterEach closes something valid
  });

  it('getStatus returns the satellite shape without creating a database', () => {
    writeFileSync(join(recallHome, 'logs', 'push.log'),
      '2026-09-04T10:00:00.000Z pushed host=sat-doctor vendor=claude path=projects/a/b.jsonl from=0 to=10\n');
    const s = getStatus();
    expect(s).toMatchObject({
      mode: 'satellite', hubUrl: hub.url, host: 'sat-doctor', tokenPresent: true,
      lastPush: '2026-09-04T10:00:00.000Z',
    });
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });

  it('runUninstall removes the satellite token', () => {
    const tokenFile = join(recallHome, 'satellite-token');
    expect(readFileSync(tokenFile, 'utf-8').trim()).toBe(hub.token);
    const res = runUninstall({});
    expect(existsSync(tokenFile)).toBe(false);
    expect(res.removed).toContain(tokenFile);
  });
});
