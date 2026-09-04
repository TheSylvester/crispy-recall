/**
 * `dist/push-pending.js` — the satellite pusher (spec §3.3).
 *
 * Runs the real staged bundle against a stub hub with seeded Claude and Codex
 * transcripts, and asserts what actually crosses the wire: manifest first,
 * only files the hub is behind on, 8 MiB chunking with `final` on the last,
 * the `X-Recall-Meta` cwd/key triple, the 7-day window, `fullSweepDue`
 * re-enumeration, 409 recovery, single-flight, and exit 0 on every failure.
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
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _setTestRoot } from '../../src/paths.js';
import { decodeMeta, type AppendMeta } from '../../src/hub/protocol.js';
import { startStubHub, type StubHub, type RecordedRequest } from '../helpers/stub-hub.js';

const REPO = join(__dirname, '..', '..');
const BUNDLE = join(REPO, 'dist', 'push-pending.js');

let sandbox: string;
let recallHome: string;
let claudeDir: string;
let codexDir: string;
let hub: StubHub;

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

function runPushBundle(args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Register this temp root as a satellite of `hub`. */
function makeSatellite(url = hub.url, token = hub.token): void {
  mkdirSync(recallHome, { recursive: true });
  writeFileSync(join(recallHome, 'config.json'), JSON.stringify({
    satellite: { hubUrl: url, host: hub.host, installedAt: new Date().toISOString() },
  }, null, 2));
  writeFileSync(join(recallHome, 'satellite-token'), `${token}\n`, { mode: 0o600 });
}

function claudeTranscript(slug: string, cwd: string | null, extra = ''): { abs: string; rel: string } {
  const id = randomUUID();
  const dir = join(claudeDir, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${id}.jsonl`);
  const line = JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: id,
    timestamp: new Date().toISOString(),
    ...(cwd ? { cwd } : {}),
    message: { role: 'user', content: `hello from ${slug} ${extra}` },
  });
  writeFileSync(abs, `${line}\n`);
  return { abs, rel: `projects/${slug}/${id}.jsonl` };
}

function codexTranscript(cwd: string): { abs: string; rel: string } {
  const id = randomUUID();
  const dir = join(codexDir, 'sessions', '2026', '09', '04');
  mkdirSync(dir, { recursive: true });
  const name = `rollout-2026-09-04T00-00-00-${id}.jsonl`;
  const abs = join(dir, name);
  writeFileSync(abs, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`);
  return { abs, rel: `sessions/2026/09/04/${name}` };
}

function metaOf(r: RecordedRequest): AppendMeta {
  const m = r.meta;
  if (!m || m instanceof Error) throw new Error(`bad meta: ${String(m)}`);
  return m;
}
const appends = () => hub.by('/v1/push/append');
const pushLog = () => {
  try { return readFileSync(join(recallHome, 'logs', 'push.log'), 'utf-8'); } catch { return ''; }
};
const logLines = () => pushLog().split('\n').filter((l) => l.trim().length > 0);

beforeEach(async () => {
  hub = await startStubHub({ host: 'sat-push' });
  sandbox = mkdtempSync(join(tmpdir(), 'recall-push-'));
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

describe('push-pending', () => {
  it('sends a manifest per vendor and appends every new file, with wire headers', async () => {
    const c = claudeTranscript('-tmp-proj', '/tmp/proj');
    const x = codexTranscript('/tmp/proj');
    const { code } = await runPushBundle();
    expect(code).toBe(0);

    const manifests = hub.by('/v1/push/manifest');
    expect(manifests.map((m) => (m.json as { vendor: string }).vendor).sort()).toEqual(['claude', 'codex']);
    for (const r of hub.requests) {
      if (r.path === '/v1/health') continue;
      expect(r.headers['x-recall-wire']).toBe('1');
      expect(r.headers['x-recall-version']).toBeDefined();
    }
    const paths = appends().map((r) => r.query.get('path'));
    expect(paths).toContain(c.rel);
    expect(paths).toContain(x.rel);
    expect(hub.files.get(`claude/${c.rel}`)?.toString()).toBe(readFileSync(c.abs, 'utf-8'));
    expect(hub.files.get(`codex/${x.rel}`)?.toString()).toBe(readFileSync(x.abs, 'utf-8'));
  });

  it('marks the last chunk final and stamps meta.cwd for a Codex session_meta', async () => {
    codexTranscript('/tmp/codex-proj');
    await runPushBundle();
    const r = appends().find((a) => a.query.get('vendor') === 'codex')!;
    expect(metaOf(r).cwd).toBe('/tmp/codex-proj');
    expect(metaOf(r).final).toBe(true);
  });

  it('derives a git: key from a real repository', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'first');
    const root = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout.trim();

    claudeTranscript('-repo', repo);
    await runPushBundle();
    expect(metaOf(appends()[0]!).key).toBe(`git:${root}`);
  });

  it('falls back to a path: key for a cwd that does not exist, and omits both without a cwd', async () => {
    claudeTranscript('-gone', '/tmp/definitely-not-here-4711');
    await runPushBundle();
    const gone = metaOf(appends()[0]!);
    expect(gone.cwd).toBe('/tmp/definitely-not-here-4711');
    expect(gone.key).toMatch(/^path:/);

    hub.requests.length = 0;
    claudeTranscript('-nocwd', null);
    await runPushBundle();
    const bare = appends().map(metaOf).find((m) => m.cwd === undefined)!;
    expect(bare).toBeDefined();
    expect(bare.key).toBeUndefined();
  });

  it('pushes a non-ASCII cwd — the ASCII guard applies to the ENCODED header only', async () => {
    const cwd = '/tmp/日本語/proj';
    claudeTranscript('-nihongo', cwd);
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    const r = appends()[0]!;
    expect(r.headers['x-recall-meta']).toMatch(/^[\x20-\x7e]*$/);
    expect(metaOf(r).cwd).toBe(cwd);
  });

  it('skips a file the hub already has, and says so in push.log', async () => {
    const c = claudeTranscript('-seeded', '/tmp/proj');
    hub.seed('claude', c.rel, readFileSync(c.abs));
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    expect(appends()).toHaveLength(0);
    expect(pushLog()).toMatch(/unchanged .*offset==size/);
  });

  it('a second run with no change appends nothing and reports unchanged on every line', async () => {
    claudeTranscript('-twice', '/tmp/proj');
    await runPushBundle();
    const after1 = appends().length;
    expect(after1).toBeGreaterThan(0);
    writeFileSync(join(recallHome, 'logs', 'push.log'), '');
    await runPushBundle();
    expect(appends()).toHaveLength(after1);
    const lines = logLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/unchanged .*offset==size/);
  });

  it('appends only the new tail when the hub holds a prefix', async () => {
    const c = claudeTranscript('-grow', '/tmp/proj');
    const head = readFileSync(c.abs);
    hub.seed('claude', c.rel, head);
    writeFileSync(c.abs, Buffer.concat([head, Buffer.from('{"more":true}\n')]));
    await runPushBundle();
    const r = appends()[0]!;
    expect(Number(r.query.get('offset'))).toBe(head.byteLength);
    expect(r.bytes?.toString()).toBe('{"more":true}\n');
  });

  it('chunks at 8 MiB and marks only the last chunk final', async () => {
    const dir = join(claudeDir, 'projects', '-big');
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const abs = join(dir, `${id}.jsonl`);
    const head = `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: '/tmp/proj', message: { role: 'user', content: 'x' } })}\n`;
    writeFileSync(abs, head + 'z'.repeat(9 * 1024 * 1024 - head.length - 1) + '\n');
    await runPushBundle();
    const chunks = appends();
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.bytes?.byteLength).toBe(8 * 1024 * 1024);
    expect(metaOf(chunks[0]!).final).toBeUndefined();
    expect(metaOf(chunks[1]!).final).toBe(true);
    expect(hub.files.get(`claude/projects/-big/${id}.jsonl`)?.byteLength).toBe(9 * 1024 * 1024);
  }, 30_000);

  it('pushes the --named file first, then the sweep', async () => {
    claudeTranscript('-other', '/tmp/proj');
    const named = claudeTranscript('-named', '/tmp/proj');
    await runPushBundle(['--named', named.abs, '--hook', JSON.stringify({ isSubagent: false }), '--cwd', '/tmp/proj']);
    expect(appends()[0]!.query.get('path')).toBe(named.rel);
    expect(appends().length).toBeGreaterThan(1);
    expect(metaOf(appends()[0]!).hook).toEqual({ isSubagent: false });
    // The hook rides ONLY the named file.
    expect(metaOf(appends()[1]!).hook).toBeUndefined();
  });

  it('skips a 10-day-old file by default, and takes it with --full', async () => {
    const old = claudeTranscript('-stale', '/tmp/proj');
    const ts = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    utimesSync(old.abs, ts, ts);
    await runPushBundle();
    expect(appends()).toHaveLength(0);

    await runPushBundle(['--full']);
    expect(appends().map((r) => r.query.get('path'))).toEqual([old.rel]);
    expect((hub.by('/v1/push/manifest').at(-1)!.json as { full: boolean }).full).toBe(true);
  });

  it('re-enumerates in the same run when the hub answers fullSweepDue', async () => {
    const other = await startStubHub({ host: 'sat-push', fullSweepDue: true });
    const old = claudeTranscript('-sweep', '/tmp/proj');
    const ts = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    utimesSync(old.abs, ts, ts);
    makeSatellite(other.url, other.token);
    try {
      const { code } = await runPushBundle();
      expect(code).toBe(0);
      expect(other.by('/v1/push/append').map((r) => r.query.get('path'))).toContain(old.rel);
      expect((other.by('/v1/push/manifest').at(-1)!.json as { full: boolean }).full).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('recovers from a 409 by continuing at the size the hub reported', async () => {
    const c = claudeTranscript('-conflict', '/tmp/proj');
    const body = readFileSync(c.abs);
    // The hub answers the manifest from an EMPTY map, then gains bytes before
    // the append lands: offset 0 collides and the hub reports its real size.
    let armed = true;
    hub.server.on('request', (req, res) => {
      if (!armed || !req.url?.includes('/v1/push/manifest')) return;
      armed = false;
      res.on('finish', () => { hub.files.set(`claude/${c.rel}`, body.subarray(0, 10)); });
    });
    writeFileSync(c.abs, Buffer.concat([body, Buffer.from('{"tail":1}\n')]));
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    const offsets = appends().map((r) => Number(r.query.get('offset')));
    expect(offsets[0]).toBe(0);
    expect(offsets).toContain(10);
    expect(hub.files.get(`claude/${c.rel}`)?.byteLength).toBe(body.byteLength + 11);
  });

  it('logs and skips the file when the hub rejects the append (426), still exiting 0', async () => {
    const other = await startStubHub({ host: 'sat-push', appendStatus: 426 });
    const c = claudeTranscript('-426', '/tmp/proj');
    makeSatellite(other.url, other.token);
    try {
      const { code } = await runPushBundle();
      expect(code).toBe(0);
      expect(other.files.size).toBe(0);
      expect(pushLog()).toContain(`path=${c.rel}`);
      expect(pushLog()).toMatch(/push-failed .*426/);
    } finally {
      await other.close();
    }
  });

  it('stands down at once when a live process holds push.lock', async () => {
    claudeTranscript('-locked', '/tmp/proj');
    mkdirSync(join(recallHome, 'run'), { recursive: true });
    writeFileSync(join(recallHome, 'run', 'push.lock'), String(process.pid));
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    expect(hub.requests).toHaveLength(0);
    expect(readFileSync(join(recallHome, 'run', 'push.lock'), 'utf-8')).toBe(String(process.pid));
  });

  it('takes over a stale lock held by a dead pid', async () => {
    const c = claudeTranscript('-stale-lock', '/tmp/proj');
    mkdirSync(join(recallHome, 'run'), { recursive: true });
    const lock = join(recallHome, 'run', 'push.lock');
    writeFileSync(lock, '999999');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(lock, old, old);
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    expect(appends().map((r) => r.query.get('path'))).toEqual([c.rel]);
    expect(existsSync(lock)).toBe(false);
  });

  it('logs one unreachable line and exits 0 when the hub is down', async () => {
    const url = hub.url;
    await hub.close();
    claudeTranscript('-down', '/tmp/proj');
    makeSatellite(url, 'irrelevant');
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    const failed = logLines().filter((l) => l.includes('push-failed'));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toContain('unreachable');
    hub = await startStubHub(); // afterEach closes something valid
  });

  it('never sends a non-ASCII header value — the file is skipped and logged', async () => {
    // The guard is unreachable in normal operation (base64url and
    // encodeURIComponent are ASCII by construction), so it is exercised
    // in-process through the `_setHeaderGuard` seam.
    const restore = _setTestRoot(recallHome);
    const prev = { c: process.env['CLAUDE_CONFIG_DIR'], x: process.env['CODEX_HOME'], r: process.env['RECALL_REMOTE_ROOT'] };
    process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
    process.env['CODEX_HOME'] = codexDir;
    process.env['RECALL_REMOTE_ROOT'] = join(sandbox, 'remote');
    const { runPush, _setHeaderGuard, headersSafe } = await import('../../src/satellite/push.js');
    const undoGuard = _setHeaderGuard(() => false);
    try {
      const c = claudeTranscript('-badheader', '/tmp/proj');
      const res = await runPush({});
      expect(res.failed).toBe(1);
      expect(appends()).toHaveLength(0);
      expect(pushLog()).toContain(`path=${c.rel}`);
      expect(pushLog()).toMatch(/non-ascii header value/);
      expect(headersSafe({ a: 'ok' })).toBe(true);
      expect(headersSafe({ a: 'ré' })).toBe(false);
    } finally {
      undoGuard();
      restore();
      if (prev.c === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prev.c;
      if (prev.x === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = prev.x;
      if (prev.r === undefined) delete process.env['RECALL_REMOTE_ROOT']; else process.env['RECALL_REMOTE_ROOT'] = prev.r;
    }
  });

  it('batches manifests at 1000 files and keeps going after a rejected batch', async () => {
    // Every file is seeded at full size, so nothing needs appending: the point
    // here is the manifest batching, not the transfer.
    const dir = join(claudeDir, 'projects', '-many');
    mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify({ type: 'user', cwd: '/tmp/proj', message: { role: 'user', content: 'm' } })}\n`;
    for (let i = 0; i < 1001; i++) {
      const id = `${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`;
      writeFileSync(join(dir, `${id}.jsonl`), body);
      hub.seed('claude', `projects/-many/${id}.jsonl`, body);
    }
    const { code } = await runPushBundle();
    expect(code).toBe(0);
    const claudeManifests = hub.by('/v1/push/manifest')
      .filter((m) => (m.json as { vendor: string }).vendor === 'claude');
    expect(claudeManifests).toHaveLength(2);
    for (const m of claudeManifests) {
      expect((m.json as { files: unknown[] }).files.length).toBeLessThanOrEqual(1000);
    }
    expect(claudeManifests.reduce((n, m) => n + (m.json as { files: unknown[] }).files.length, 0)).toBe(1001);
    expect(appends()).toHaveLength(0);
  }, 60_000);

  it('a rejected first batch does not abandon the remaining batches', async () => {
    const other = await startStubHub({ host: 'sat-push', manifestStatuses: [400] });
    const dir = join(claudeDir, 'projects', '-many2');
    mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify({ type: 'user', cwd: '/tmp/proj', message: { role: 'user', content: 'm' } })}\n`;
    for (let i = 0; i < 1001; i++) {
      const id = `${String(i).padStart(4, '0')}-1111-4000-8000-000000000000`;
      writeFileSync(join(dir, `${id}.jsonl`), body);
      other.seed('claude', `projects/-many2/${id}.jsonl`, body);
    }
    makeSatellite(other.url, other.token);
    try {
      const { code } = await runPushBundle();
      expect(code).toBe(0);
      const claudeManifests = other.by('/v1/push/manifest')
        .filter((m) => (m.json as { vendor: string }).vendor === 'claude');
      expect(claudeManifests).toHaveLength(2);
      expect(claudeManifests[0]!.status).toBe(400);
      expect(claudeManifests[1]!.status).toBe(200);
      expect(pushLog()).toMatch(/manifest replied 400/);
    } finally {
      await other.close();
    }
  }, 60_000);

  it('treats an unparseable 200 manifest body as a transport failure', async () => {
    const other = await startStubHub({ host: 'sat-push', manifestGarbage: 'not json at all' });
    claudeTranscript('-garbage', '/tmp/proj');
    makeSatellite(other.url, other.token);
    try {
      const { code } = await runPushBundle();
      expect(code).toBe(0);
      expect(other.by('/v1/push/append')).toHaveLength(0);
      expect(pushLog()).toMatch(/push-failed .*manifest body unparseable/);
      // Fatal, so the run stops instead of moving on to the next vendor.
      expect(other.by('/v1/push/manifest')).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it('the lock heartbeat bumps the mtime and never blanks the pid', async () => {
    const restore = _setTestRoot(recallHome);
    const { tryAcquirePushLock, releasePushLock, startLockHeartbeat, pushLockPath } =
      await import('../../src/satellite/push.js');
    try {
      expect(tryAcquirePushLock()).toBe(true);
      const before = statSync(pushLockPath()).mtimeMs;
      const stop = startLockHeartbeat(20);
      try {
        await new Promise((r) => setTimeout(r, 200));
        expect(readFileSync(pushLockPath(), 'utf-8')).toBe(String(process.pid));
        expect(statSync(pushLockPath()).mtimeMs).toBeGreaterThan(before);
      } finally {
        stop();
      }
      releasePushLock();
      expect(existsSync(pushLockPath())).toBe(false);
    } finally {
      restore();
    }
  });

  it('decodes every meta header it sent', () => {
    expect(decodeMeta('!!!not-json!!!')).toBeInstanceOf(Error);
  });
});
