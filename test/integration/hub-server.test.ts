/**
 * Hub daemon over a real socket (spec §2.3): spawned `dist/recall.js hub
 * serve --bind 127.0.0.1 --port 0`, tokens issued through the CLI, every
 * endpoint's status codes, live revoke/rotate, and proxied queries that are
 * byte-identical to running the CLI directly with the hub-appended flags.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CLI_BUNDLE, NODE, appendPath, authHeaders, claudeEntry, cli, createDb, dbRows, hostRecords, hubLogLines,
  issueToken, makeSandbox, metaHeader, readHubJson, req, sleep, stageFakeBackend, stagePlaceholders,
  startDaemon, waitFor, type Daemon, type Sandbox,
} from './helpers/hub-harness.js';

const win32 = platform() === 'win32';
const REPO_KEY = 'git:' + 'c'.repeat(40);

describe.skipIf(win32)('hub daemon — push endpoints', () => {
  let sb: Sandbox;
  let d: Daemon;
  let token: string;

  beforeAll(async () => {
    sb = makeSandbox();
    expect(resolve(sb.recallHome).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(sb.remote).startsWith(resolve(tmpdir()))).toBe(true);
    stagePlaceholders(sb.recallHome);
    createDb(sb);
    token = issueToken(sb, 'sat1');
    d = await startDaemon(sb);
  }, 60_000);

  afterAll(async () => {
    await d?.stop();
    sb?.cleanup();
  });

  it('token file is 0600 and holds only a sha256, never the token', () => {
    const p = join(sb.recallHome, 'hub-tokens.json');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const text = readFileSync(p, 'utf-8');
    expect(text).not.toContain(token);
    expect(Object.keys(JSON.parse(text).tokens)[0]).toMatch(/^[0-9a-f]{64}$/);
    const out = cli(sb, ['hub', 'token', '--host', 'sat2']).stdout;
    expect(out).toContain('effective immediately, no restart needed');
  });

  it('/v1/health is unauthenticated and has the §2.3 shape', async () => {
    const r = await req(d.url, { method: 'GET', path: '/v1/health' });
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(true);
    expect(j.wire).toBe(1);
    expect(typeof j.version).toBe('string');
    expect(typeof j.hub).toBe('string');
    expect(j.runtime).toEqual({ binary: true, model: true });
  });

  it('426 on missing AND mismatched wire on manifest, append and query — before auth', async () => {
    for (const [method, path] of [['POST', '/v1/push/manifest'], ['PUT', appendPath('claude', 'projects/a/b.jsonl', 0)], ['POST', '/v1/query']] as const) {
      const missing = await req(d.url, { method, path, headers: { authorization: `Bearer ${token}` }, body: '{}' });
      expect(missing.status).toBe(426);
      expect(missing.json()).toMatchObject({ wire: 1 });
      const mismatched = await req(d.url, { method, path, headers: { authorization: `Bearer ${token}`, 'x-recall-wire': '99' }, body: '{}' });
      expect(mismatched.status).toBe(426);
      const noAuthWrongWire = await req(d.url, { method, path, headers: { 'x-recall-wire': '2' }, body: '{}' });
      expect(noAuthWrongWire.status).toBe(426);
    }
  });

  it('401 on no header, a bad token, and a revoked token', async () => {
    const body = JSON.stringify({ vendor: 'claude', full: false, files: [] });
    expect((await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: { 'x-recall-wire': '1' }, body })).status).toBe(401);
    expect((await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders('f'.repeat(64)), body })).status).toBe(401);
    const t2 = issueToken(sb, 'revoked-host');
    expect((await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(t2), body })).status).toBe(200);
    expect(cli(sb, ['hub', 'token', '--revoke', 'revoked-host']).status).toBe(0);
    expect((await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(t2), body })).status).toBe(401);
  });

  it('revoke and rotate are effective without a restart (same pid)', async () => {
    const pidBefore = d.pid;
    const old = issueToken(sb, 'rot');
    const body = JSON.stringify({ vendor: 'claude', full: false, files: [] });
    expect((await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(old), body })).status).toBe(200);
    const fresh = issueToken(sb, 'rot'); // rotate
    expect(fresh).not.toBe(old);
    expect((await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(old), body })).status).toBe(401);
    const ok = await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(fresh), body });
    expect(ok.status).toBe(200);
    expect(ok.json().host).toBe('rot');
    expect(readHubJson(sb)!.pid).toBe(pidBefore);
    expect(() => process.kill(pidBefore, 0)).not.toThrow();
  });

  it('append: 411 without Content-Length, 413 above 8 MiB (from the header), 400 on early end', async () => {
    const path = appendPath('claude', `projects/-p/${randomUUID()}.jsonl`, 0);
    const h = authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/home/x/proj' }) });
    expect((await req(d.url, { method: 'PUT', path, headers: h, body: 'x', chunked: true })).status).toBe(411);
    const big = await req(d.url, { method: 'PUT', path, headers: h, body: 'x', declareLength: 8 * 1024 * 1024 + 1 });
    expect(big.status).toBe(413);
    const short = await req(d.url, { method: 'PUT', path, headers: h, body: 'abc', declareLength: 100 });
    expect(short.status).toBe(400);
    // The file was never created by any of the three.
    expect(existsSync(join(sb.remote, 'sat1', 'claude', 'projects', '-p'))).toBe(false);
  });

  it('append: 400 on every path rule, bad meta, bad offset, bad vendor', async () => {
    const h = authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/home/x/proj' }) });
    for (const rel of ['../x.jsonl', 'projects/../x.jsonl', '/projects/x.jsonl', 'C:/projects/x.jsonl', 'projects/a?b.jsonl', 'sessions/x.jsonl', 'projects/x.txt', 'projects/a\x01/x.jsonl', '//?/C:/x/projects/x.jsonl']) {
      const r = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: h, body: 'x\n' });
      expect(r.status, rel).toBe(400);
    }
    expect((await req(d.url, { method: 'PUT', path: appendPath('codex', 'projects/x.jsonl', 0), headers: h, body: 'x\n' })).status).toBe(400);
    expect((await req(d.url, { method: 'PUT', path: appendPath('claude', 'projects/x.jsonl', 0), headers: authHeaders(token), body: 'x\n' })).status).toBe(400); // no meta
    expect((await req(d.url, { method: 'PUT', path: appendPath('claude', 'projects/x.jsonl', 0), headers: authHeaders(token, { 'x-recall-meta': '!!' }), body: 'x\n' })).status).toBe(400);
    expect((await req(d.url, { method: 'PUT', path: `/v1/push/append?vendor=claude&path=projects%2Fx.jsonl&offset=-1`, headers: h, body: 'x\n' })).status).toBe(400);
    expect((await req(d.url, { method: 'PUT', path: `/v1/push/append?vendor=gemini&path=projects%2Fx.jsonl&offset=0`, headers: h, body: 'x\n' })).status).toBe(400);
    expect(hubLogLines(sb).some((l) => l.includes('path-rejected host=sat1'))).toBe(true);
  });

  it('append 200 {size}, sidecar exists the instant the response arrives, then 409 {size}', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-x-proj/${sid}.jsonl`;
    const body = claudeEntry(sid, 0, 'first turn about the walrus, padded to clear the fifty character floor');
    const meta = { cwd: '/home/x/proj', key: REPO_KEY, hook: { isSubagent: false, payloadSessionId: sid }, final: true };
    const r = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: authHeaders(token, { 'x-recall-meta': metaHeader(meta) }), body });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ size: Buffer.byteLength(body) });
    const abs = join(sb.remote, 'sat1', 'claude', rel);
    const sidecar = `${abs}.meta.json`;
    expect(existsSync(sidecar)).toBe(true); // written BEFORE the 200 was sent
    const sc = JSON.parse(readFileSync(sidecar, 'utf-8'));
    expect(sc).toMatchObject({ host: 'sat1', cwd: '/home/x/proj', key: REPO_KEY, hook: meta.hook, v: 1 });
    expect(typeof sc.updatedAt).toBe('string');
    expect(sc.final).toBeUndefined();
    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    const dup = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: authHeaders(token, { 'x-recall-meta': metaHeader(meta) }), body });
    expect(dup.status).toBe(409);
    expect(dup.json()).toEqual({ size: Buffer.byteLength(body) });
    // Ingest landed with the satellite's key and cwd (hook context present).
    expect(await waitFor(() => dbRows(sb.dbFile, 'SELECT 1 FROM messages WHERE session_id = ?', [sid]).length > 0)).toBe(true);
    const rows = dbRows<{ project_id: string; project_key: string }>(sb.dbFile, 'SELECT project_id, project_key FROM messages WHERE session_id = ?', [sid]);
    expect(rows[0]).toEqual({ project_id: '/home/x/proj', project_key: REPO_KEY });
    const wm = dbRows<{ transcript_path: string; last_size: number; vendor: string }>(sb.dbFile, 'SELECT transcript_path, last_size, vendor FROM ingest_watermark');
    expect(wm.find((w) => w.transcript_path.endsWith(`/${sid}.jsonl`))).toMatchObject({ last_size: Buffer.byteLength(body), vendor: 'claude' });
    expect(hostRecords(sb)['sat1']?.lastPushAt).toBeTruthy();
  });

  it('append: second chunk at the right offset grows the file; ingest without hook context', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-x-proj/${sid}.jsonl`;
    const a = claudeEntry(sid, 0, 'chunk one about the narwhal, padded to clear the fifty character floor');
    const b = claudeEntry(sid, 1, 'chunk two about the narwhal, padded to clear the fifty character floor');
    const h = authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/home/x/proj' }) });
    expect((await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: h, body: a })).status).toBe(200);
    const r2 = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, Buffer.byteLength(a)), headers: h, body: b });
    expect(r2.status).toBe(200);
    expect(r2.json().size).toBe(Buffer.byteLength(a) + Buffer.byteLength(b));
    expect(await waitFor(() => dbRows(sb.dbFile, 'SELECT 1 FROM messages WHERE session_id = ?', [sid]).length === 2)).toBe(true);
    const row = dbRows<{ project_key: string | null; project_id: string }>(sb.dbFile, 'SELECT project_id, project_key FROM messages WHERE session_id = ? LIMIT 1', [sid])[0];
    expect(row).toEqual({ project_id: '/home/x/proj', project_key: null }); // no key shipped → NULL, never derived
  });

  it('reset requires offset=0 and leaves a .superseded- sibling', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-x-proj/${sid}.jsonl`;
    const a = claudeEntry(sid, 0, 'before the reset, padded well past the fifty character embedding floor');
    const h = (extra: object) => authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/home/x/proj', ...extra }) });
    expect((await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: h({}), body: a })).status).toBe(200);
    const bad = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, Buffer.byteLength(a)), headers: h({ reset: true }), body: a });
    expect(bad.status).toBe(400);
    const ok = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: h({ reset: true, final: true }), body: a });
    expect(ok.status).toBe(200);
    expect(ok.json().size).toBe(Buffer.byteLength(a));
    const dir = join(sb.remote, 'sat1', 'claude', 'projects', '-home-x-proj');
    const siblings = readdirSync(dir).filter((n) => n.startsWith(`${sid}.jsonl.superseded-`));
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).not.toContain(':');
  });

  it('manifest: offset = on-disk size, reset when hub size > reported, limits enforced', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-x-proj/${sid}.jsonl`;
    const a = claudeEntry(sid, 0, 'manifest fixture line, padded well past the fifty character floor');
    await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/home/x/proj' }) }), body: a });
    const size = Buffer.byteLength(a);
    const post = (body: unknown) => req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(token), body: JSON.stringify(body) });
    const r = await post({ vendor: 'claude', full: false, files: [
      { path: rel, size: size + 100, mtime: 1 },
      { path: rel, size: size - 1, mtime: 1 },
      { path: 'projects/-never/x.jsonl', size: 5, mtime: 1 },
    ] });
    expect(r.status).toBe(200);
    expect(r.json().files).toEqual([{ path: rel, offset: size }, { path: rel, offset: size, reset: true }, { path: 'projects/-never/x.jsonl', offset: 0 }]);
    expect((await post({ vendor: 'claude', full: false, files: [{ path: '../x.jsonl', size: 1, mtime: 1 }] })).status).toBe(400);
    expect((await post({ vendor: 'claude', full: false, files: new Array(1001).fill({ path: 'projects/a.jsonl', size: 1, mtime: 1 }) })).status).toBe(400);
    expect((await post({ vendor: 'claude', full: 'yes', files: [] })).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
    const huge = await req(d.url, { method: 'POST', path: '/v1/push/manifest', headers: authHeaders(token), body: JSON.stringify({ vendor: 'claude', full: false, files: [], pad: 'x'.repeat(256 * 1024) }) });
    expect(huge.status).toBe(413);
  });

  it('SIGUSR1 runs one mirror sweep: a file dropped straight into the mirror is ingested', async () => {
    const sid = randomUUID();
    const dir = join(sb.remote, 'sat1', 'claude', 'projects', '-usr1');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), claudeEntry(sid, 0, 'dropped in by hand for the SIGUSR1 sweep, past the fifty char floor'));
    process.kill(d.pid, 'SIGUSR1');
    expect(await waitFor(() => dbRows(sb.dbFile, 'SELECT 1 FROM messages WHERE session_id = ?', [sid]).length > 0)).toBe(true);
    expect(dbRows<{ project_key: string | null }>(sb.dbFile, 'SELECT project_key FROM messages WHERE session_id = ?', [sid])[0]!.project_key).toBeNull(); // no sidecar → NULL, never derived
    expect(await waitFor(() => hubLogLines(sb).some((l) => l.includes('sweep reason=SIGUSR1')))).toBe(true);
    expect(readHubJson(sb)!.pid).toBe(d.pid);
  }, 20_000);

  it('hub status --json reports the live daemon and the host', async () => {
    const r = cli(sb, ['hub', 'status', '--json']);
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.daemon).toMatchObject({ alive: true, pid: d.pid, port: d.port, address: '127.0.0.1' });
    expect(s.daemon.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(s.configured).toEqual({ bind: '127.0.0.1', port: 7877 }); // a resolved --port 0 is never persisted
    const sat1 = s.hosts.find((h: { host: string }) => h.host === 'sat1');
    expect(sat1.files).toBeGreaterThan(0);
    expect(sat1.lastPushAt).toBeTruthy();
    expect(typeof sat1.refusedCollisions).toBe('number');
    expect(s.tokens).toContain('sat1');
    const text = cli(sb, ['hub', 'status']).stdout;
    expect(text).toContain(`resolved 127.0.0.1:${d.port}`);
    expect(text).not.toContain(token);
    expect(readFileSync(join(sb.recallHome, 'logs', 'hub.log'), 'utf-8')).not.toContain(token);
  });
});

describe.skipIf(win32)('hub daemon — proxied queries (fake embedder)', () => {
  let sb: Sandbox;
  let d: Daemon;
  let token: string;
  const term = 'wolverine';
  let sid: string;

  beforeAll(async () => {
    sb = makeSandbox();
    stageFakeBackend(sb.recallHome);
    createDb(sb);
    token = issueToken(sb, 'qhost');
    d = await startDaemon(sb);
    sid = randomUUID();
    const rel = `projects/-home-x-proj/${sid}.jsonl`;
    const body = claudeEntry(sid, 0, `${term} narration for the proxied query, padded past the fifty char floor`);
    const r = await req(d.url, { method: 'PUT', path: appendPath('claude', rel, 0), headers: authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/home/x/proj', key: REPO_KEY, final: true }) }), body });
    expect(r.status).toBe(200);
    expect(await waitFor(() => dbRows(sb.dbFile, 'SELECT 1 FROM messages WHERE session_id = ?', [sid]).length > 0)).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await d?.stop();
    sb?.cleanup();
  });

  function query(body: unknown, extraHeaders?: Record<string, string>) {
    return req(d.url, { method: 'POST', path: '/v1/query', headers: authHeaders(token, extraHeaders), body: JSON.stringify(body) });
  }

  it('proxied output is byte-identical to the CLI run directly with the hub-appended flags', async () => {
    const r = await query({ argv: [term], cwd: '/home/x/proj', key: REPO_KEY });
    expect(r.status).toBe(200);
    const via = r.json();
    const direct = spawnSync(NODE, [CLI_BUNDLE, term, '--project-key', REPO_KEY, '--project', '/home/x/proj', '--no-catchup'], {
      cwd: homedir(), env: sb.env(), encoding: 'utf-8', timeout: 60_000,
    });
    expect(via.exit).toBe(direct.status);
    expect(via.stdout).toBe(direct.stdout);
    expect(via.stderr).toBe(direct.stderr);
    expect(via.stdout).toContain(sid);
    expect(r.headers['x-recall-stale']).toBeUndefined();
    expect(hostRecords(sb)['qhost']?.lastQueryAt).toBeTruthy();
  }, 60_000);

  it('a different cwd + key scopes the row away; --all brings it back', async () => {
    const other = await query({ argv: [term], cwd: '/some/other', key: 'path:/some/other' });
    expect(other.status).toBe(200);
    expect(other.json().stdout).not.toContain(sid);
    const all = await query({ argv: [term, '--all'], cwd: '/some/other', key: 'path:/some/other' });
    expect(all.json().stdout).toContain(sid);
    const read = await query({ argv: [sid], cwd: '/some/other' });
    expect(read.json().exit).toBe(0);
    expect(read.json().stdout).toContain(term);
  }, 60_000);

  it('400 on --project / --project-key, rejected positionals, and body limits', async () => {
    const p = await query({ argv: [term, '--project', '/x'], cwd: '/home/x/proj' });
    expect(p.status).toBe(400);
    expect(p.json().error).toBe('--project must be resolved on the satellite');
    expect((await query({ argv: [term, '--project-key', REPO_KEY], cwd: '/home/x/proj' })).status).toBe(400);
    expect((await query({ argv: ['install'], cwd: '/home/x/proj' })).status).toBe(400);
    expect((await query({ argv: ['hub', 'serve'], cwd: '/home/x/proj' })).status).toBe(400);
    expect((await query({ argv: [term, '--vendor', 'codex'], cwd: '/home/x/proj' })).status).toBe(400);
    expect((await query({ argv: new Array(65).fill('a'), cwd: '/x' })).status).toBe(400);
    expect((await query({ argv: ['a'.repeat(4097)], cwd: '/x' })).status).toBe(400);
    expect((await query({ argv: ['a\u0000b'], cwd: '/x' })).status).toBe(400);
    expect((await query({ argv: ['a'], cwd: '-x' })).status).toBe(400);
    expect((await query({ argv: ['a'], cwd: '' })).status).toBe(400);
    expect((await query({ argv: ['a'], cwd: '/x', key: 'nope' })).status).toBe(400);
    expect((await query({ argv: ['a'], cwd: '/x', pad: 'x'.repeat(64 * 1024) })).status).toBe(400);
    expect((await req(d.url, { method: 'POST', path: '/v1/query', headers: authHeaders(token), body: '{not json' })).status).toBe(400);
  });
});

describe.skipIf(win32)('hub daemon — scope proof with a recording CLI stub', () => {
  let sb: Sandbox;
  let d: Daemon;
  let token: string;

  beforeAll(async () => {
    sb = makeSandbox();
    stagePlaceholders(sb.recallHome);
    createDb(sb);
    token = issueToken(sb, 'stubhost');
    const stub = join(sb.tmp, 'record-argv.js');
    writeFileSync(stub, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write('E');process.exit(3);\n");
    chmodSync(stub, 0o755);
    d = await startDaemon(sb, { env: { RECALL_HUB_CLI: stub } });
  }, 60_000);

  afterAll(async () => {
    await d?.stop();
    sb?.cleanup();
  });

  async function spawned(body: unknown): Promise<{ argv: string[]; exit: number; stderr: string }> {
    const r = await req(d.url, { method: 'POST', path: '/v1/query', headers: authHeaders(token), body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    const j = r.json() as { stdout: string; stderr: string; exit: number };
    return { argv: JSON.parse(j.stdout) as string[], exit: j.exit, stderr: j.stderr };
  }

  it('the hub is the sole writer of scope: exactly one --project (= normalizePath(cwd)), one --project-key, --no-catchup', async () => {
    const r = await spawned({ argv: ['walrus', 'tusks', '--context', '4', '--limit', '7'], cwd: 'C:\\Users\\me\\proj\\', key: REPO_KEY });
    expect(r.argv.filter((a) => a === '--project')).toHaveLength(1);
    expect(r.argv.filter((a) => a === '--project-key')).toHaveLength(1);
    expect(r.argv[r.argv.indexOf('--project') + 1]).toBe('c:/Users/me/proj');
    expect(r.argv[r.argv.indexOf('--project-key') + 1]).toBe(REPO_KEY);
    expect(r.argv).not.toContain('--context');
    expect(r.argv).not.toContain('4');
    expect(r.argv.slice(0, 4)).toEqual(['walrus', 'tusks', '--limit', '7']);
    expect(r.argv[r.argv.length - 1]).toBe('--no-catchup');
    expect(r.exit).toBe(3);
    expect(r.stderr).toBe('E');
  });

  it('with --all neither scope flag is appended; without key only --project', async () => {
    const all = await spawned({ argv: ['walrus', '--all'], cwd: '/home/x/proj', key: REPO_KEY });
    expect(all.argv).toEqual(['walrus', '--all', '--no-catchup']);
    const noKey = await spawned({ argv: ['walrus'], cwd: '/home/x/proj' });
    expect(noKey.argv).toEqual(['walrus', '--project', '/home/x/proj', '--no-catchup']);
  });
});

describe.skipIf(win32)('hub daemon — queue drain and X-Recall-Stale (in-process seam)', () => {
  it('sets X-Recall-Stale: 1 only while an ingest for the host is still queued', async () => {
    const { startHubServer } = await import('../../src/hub/server.js');
    const { QueryRunner } = await import('../../src/hub/query.js');
    const { issueHubToken } = await import('../../src/hub/tokens.js');
    const { _setTestRoot } = await import('../../src/paths.js');
    const sb = makeSandbox('recall-hub-stale-');
    const restore = _setTestRoot(sb.recallHome);
    const prev: Record<string, string | undefined> = {};
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_REMOTE_ROOT']) prev[k] = process.env[k];
    process.env['CLAUDE_CONFIG_DIR'] = sb.claude;
    process.env['CODEX_HOME'] = sb.codex;
    process.env['RECALL_REMOTE_ROOT'] = sb.remote;
    const stub = join(sb.tmp, 'stub.js');
    writeFileSync(stub, "process.stdout.write('ok');\n");
    try {
      const token = issueHubToken('slow');
      let ingests = 0;
      const h = await startHubServer({
        bind: '127.0.0.1', port: 0, sweepMs: null, startupSweep: false, drainCapMs: 150,
        runIngest: async () => { ingests++; await sleep(700); return 'ingested'; },
        queryRunner: new QueryRunner({ cli: () => stub }),
      });
      try {
        const url = `http://127.0.0.1:${h.port}`;
        const sid = randomUUID();
        const put = await req(url, { method: 'PUT', path: appendPath('claude', `projects/-p/${sid}.jsonl`, 0), headers: authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/p', final: true }) }), body: 'x\n' });
        expect(put.status).toBe(200);
        const stale = await req(url, { method: 'POST', path: '/v1/query', headers: authHeaders(token), body: JSON.stringify({ argv: ['q'], cwd: '/p' }) });
        expect(stale.status).toBe(200);
        expect(stale.headers['x-recall-stale']).toBe('1');
        expect(stale.json().stdout).toBe('ok');
        await h.queue.idle(5_000);
        expect(ingests).toBe(1);
        const fresh = await req(url, { method: 'POST', path: '/v1/query', headers: authHeaders(token), body: JSON.stringify({ argv: ['q'], cwd: '/p' }) });
        expect(fresh.headers['x-recall-stale']).toBeUndefined();
        // A body without a trailing newline and without `final` never enqueues.
        const noNl = await req(url, { method: 'PUT', path: appendPath('claude', `projects/-p/${sid}.jsonl`, 2), headers: authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/p' }) }), body: 'partial' });
        expect(noNl.status).toBe(200);
        await sleep(50);
        expect(ingests).toBe(1);
      } finally {
        await h.stop();
      }
    } finally {
      restore();
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      sb.cleanup();
    }
  }, 30_000);
});
