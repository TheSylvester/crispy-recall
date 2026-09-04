/**
 * `dist/stop-hook.js` on a satellite (spec §3.2, S6).
 *
 * The hook must hand the transcript to a detached push-pending and get out of
 * the turn's way: exit 0 fast, no stop-hook.log, no database. A hub root must
 * keep the existing behaviour, which the pre-existing stop-hook suite covers
 * in full; here we only assert that a root with no satellite record does NOT
 * take the new branch.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO = join(__dirname, '..', '..');
const HOOK = join(REPO, 'dist', 'stop-hook.js');

let sandbox: string;
let recallHome: string;
let claudeDir: string;
let codexDir: string;
let argvFile: string;

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RECALL_HOME: recallHome,
    RECALL_REMOTE_ROOT: join(sandbox, 'remote'),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    RECALL_LOG_LEVEL: 'error',
  };
}

function runHook(payload: object): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: childEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, ms: Date.now() - started }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** A stand-in for the staged push-pending bundle: it records its argv. */
function stagePushRecorder(): void {
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  writeFileSync(
    join(recallHome, 'bin', 'push-pending.js'),
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
}

function makeSatellite(): void {
  mkdirSync(recallHome, { recursive: true });
  writeFileSync(join(recallHome, 'config.json'), JSON.stringify({
    satellite: { hubUrl: 'http://127.0.0.1:1', host: 'sat-hook', installedAt: new Date().toISOString() },
  }, null, 2));
  writeFileSync(join(recallHome, 'satellite-token'), 'token\n');
}

function transcript(cwd: string): string {
  const id = randomUUID();
  const dir = join(claudeDir, 'projects', '-tmp-hook');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${id}.jsonl`);
  writeFileSync(abs, `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd, message: { role: 'user', content: 'turn' } })}\n`);
  return abs;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-sat-hook-'));
  recallHome = join(sandbox, '.recall');
  claudeDir = join(sandbox, '.claude');
  codexDir = join(sandbox, '.codex');
  argvFile = join(sandbox, 'push-argv.json');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
});

afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

describe('satellite stop hook', () => {
  it('spawns push-pending --named/--hook/--cwd, exits 0 fast, writes no log and no DB', async () => {
    makeSatellite();
    stagePushRecorder();
    const t = transcript('/tmp/hookproj');
    const sid = randomUUID();
    const res = await runHook({ session_id: sid, transcript_path: t, cwd: '/tmp/hookproj' });
    expect(res.code).toBe(0);
    expect(res.ms).toBeLessThan(2000);
    expect(await waitFor(() => existsSync(argvFile))).toBe(true);
    const argv = JSON.parse(readFileSync(argvFile, 'utf-8')) as string[];
    expect(argv[0]).toBe('--named');
    expect(argv[1]).toBe(t);
    expect(argv[2]).toBe('--hook');
    expect(JSON.parse(argv[3]!)).toEqual({ payloadSessionId: sid, isSubagent: false });
    expect(argv[4]).toBe('--cwd');
    expect(argv[5]).toBe('/tmp/hookproj');
    expect(existsSync(join(recallHome, 'logs', 'stop-hook.log'))).toBe(false);
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(false);
  });

  it('marks a SubagentStop payload isSubagent in --hook', async () => {
    makeSatellite();
    stagePushRecorder();
    const t = transcript('/tmp/hookproj');
    await runHook({ session_id: randomUUID(), agent_id: 'agent-abc123', agent_transcript_path: t, cwd: '/tmp/hookproj' });
    expect(await waitFor(() => existsSync(argvFile))).toBe(true);
    const argv = JSON.parse(readFileSync(argvFile, 'utf-8')) as string[];
    expect(JSON.parse(argv[3]!)).toMatchObject({ agentId: 'agent-abc123', isSubagent: true });
  });

  it('a hub root (no satellite record) does NOT take the satellite branch', async () => {
    stagePushRecorder();
    const t = transcript('/tmp/hookproj');
    const res = await runHook({ session_id: randomUUID(), transcript_path: t, cwd: '/tmp/hookproj' });
    expect(res.code).toBe(0);
    // Give any (wrongly) spawned child time to land before asserting absence.
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(argvFile)).toBe(false);
    expect(existsSync(join(recallHome, 'recall.db'))).toBe(true);
  });
});
