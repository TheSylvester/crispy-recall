/**
 * runPreflight({ satellite }) — the satellite pre-flight contract (spec §3.1).
 *
 * Asserts the Node 20 floor (Node 23 still excluded), that the local-runtime
 * checks are skipped, and that the HuggingFace/GitHub probes are replaced by
 * `GET /v1/health` plus an authenticated empty manifest against a stub hub —
 * with `hub.unreachable` and `hub.auth` telling apart "no hub" from "bad
 * token".
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import { runPreflight } from '../../src/installer/preflight.js';
import { startStubHub, type StubHub } from '../helpers/stub-hub.js';

let sandbox: string;
let restore: () => void;
let prevClaude: string | undefined;
let prevCodex: string | undefined;
let prevRemote: string | undefined;
let hub: StubHub;

beforeAll(async () => { hub = await startStubHub({ host: 'sat-preflight' }); });
afterAll(async () => { await hub.close(); });

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sat-preflight-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  mkdirSync(join(sandbox, '.claude'), { recursive: true });
  prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  prevCodex = process.env['CODEX_HOME'];
  prevRemote = process.env['RECALL_REMOTE_ROOT'];
  process.env['CLAUDE_CONFIG_DIR'] = join(sandbox, '.claude');
  process.env['CODEX_HOME'] = join(sandbox, '.codex-absent');
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, 'remote');
});

afterEach(() => {
  restore?.();
  for (const [k, v] of [['CLAUDE_CONFIG_DIR', prevClaude], ['CODEX_HOME', prevCodex], ['RECALL_REMOTE_ROOT', prevRemote]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function opts(nodeVersion: string, over: Partial<{ hubUrl: string; token: string | null }> = {}) {
  return {
    platform: 'linux' as NodeJS.Platform,
    arch: 'x64',
    nodeVersion,
    satellite: { hubUrl: over.hubUrl ?? hub.url, token: over.token === undefined ? hub.token : over.token },
  };
}
const nodeFail = (r: Awaited<ReturnType<typeof runPreflight>>) => r.failures.find((f) => f.check === 'runtime.node');

describe('preflight (satellite)', () => {
  it.each(['v20.0.0', 'v20.20.1', 'v22.18.0', 'v24.4.0'])('accepts Node %s', async (v) => {
    const r = await runPreflight(opts(v));
    expect(nodeFail(r)).toBeUndefined();
  });

  it.each(['v18.0.0', 'v19.9.0', 'v23.1.0'])('FAILs Node %s', async (v) => {
    const r = await runPreflight(opts(v));
    const f = nodeFail(r);
    expect(f?.severity).toBe('FAIL');
    expect(f?.message).toMatch(/Node 20\+/);
  });

  it('skips the disk, macOS-floor and GPU checks', async () => {
    const r = await runPreflight(opts('v20.20.1', {}));
    expect(r.runtime.disk).toBe('n/a (satellite)');
    expect(r.runtime.gpu).toEqual({ detected: false, vendor: 'none', cudaAvailable: 'none', plannedMode: 'cpu' });
    expect(r.failures.find((f) => f.check === 'platform.macos-version')).toBeUndefined();
  });

  it('probes the hub instead of HuggingFace/GitHub and returns the host', async () => {
    const before = hub.by('/v1/health').length;
    const r = await runPreflight(opts('v20.20.1'));
    expect(hub.by('/v1/health').length).toBe(before + 1);
    expect(hub.by('/v1/push/manifest').at(-1)?.json).toMatchObject({ vendor: 'claude', full: false, files: [] });
    expect(r.satellite).toMatchObject({ hubUrl: hub.url, host: 'sat-preflight' });
    expect(r.runtime.network).toMatch(/auth ok/);
  });

  it('keeps the ~/.claude FAIL', async () => {
    rmSync(join(sandbox, '.claude'), { recursive: true, force: true });
    const r = await runPreflight(opts('v20.20.1'));
    expect(r.failures.find((f) => f.check === 'claude.dir')?.severity).toBe('FAIL');
  });

  it('FAILs hub.unreachable when nothing is listening', async () => {
    const dead = await startStubHub();
    const url = dead.url;
    await dead.close();
    const r = await runPreflight(opts('v20.20.1', { hubUrl: url }));
    const f = r.failures.find((x) => x.check === 'hub.unreachable');
    expect(f?.severity).toBe('FAIL');
    expect(r.failures.find((x) => x.check === 'hub.auth')).toBeUndefined();
  });

  it('FAILs hub.auth on a bad token, naming the status', async () => {
    const r = await runPreflight(opts('v20.20.1', { token: 'not-the-token' }));
    const f = r.failures.find((x) => x.check === 'hub.auth');
    expect(f?.message).toMatch(/401/);
  });

  it('FAILs hub.auth with the wire version when the hub speaks another wire', async () => {
    const other = await startStubHub({ wire: 99 });
    try {
      const r = await runPreflight(opts('v20.20.1', { hubUrl: other.url, token: other.token }));
      const f = r.failures.find((x) => x.check === 'hub.auth');
      expect(f?.message).toMatch(/426/);
      expect(f?.message).toMatch(/wire 1/);
    } finally {
      await other.close();
    }
  });

  it('FAILs hub.auth when no token was supplied at all', async () => {
    const r = await runPreflight(opts('v20.20.1', { token: null }));
    expect(r.failures.find((x) => x.check === 'hub.auth')?.message).toMatch(/no hub token/);
  });
});
