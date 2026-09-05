/**
 * Push-time ingest (spec §2.4), the mirror sweep, `mtimeScan` roots,
 * `repair --full` on a mirror, and the doctor hub section — IN-PROCESS.
 *
 * In-process rule: every suite that calls `repairFull`, `runDoctor` pieces or
 * any installer function in-process MUST first call `_setTestRoot(<tmp>/.recall)`
 * AND set CLAUDE_CONFIG_DIR, CODEX_HOME and RECALL_REMOTE_ROOT to temp dirs.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { _setTestRoot, dbPath, recallRoot, remoteRoot, transcriptGlob } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { runPushIngest, type PushIngestDeps, type PushIngestJob } from '../../src/hub/ingest-queue.js';
import { mirrorFilePath, mirrorRoots, mirrorVendorRoot, writeSidecar } from '../../src/hub/mirror.js';
import { runMirrorSweep } from '../../src/hub/sweep.js';
import { startHubServer } from '../../src/hub/server.js';
import { issueHubToken } from '../../src/hub/tokens.js';
import { repairFull } from '../../src/installer/repair.js';
import {
  HUB_LOG_TAIL_BYTES, checkHubHealth, hasCollisionEvidence, printHub, readCollisionEvidence,
} from '../../src/installer/doctor.js';
import { writeHubConfig } from '../../src/installer/config.js';
import { clearProjectKeyCache } from '../../src/recall/project-key.js';
import { appendPath, authHeaders, claudeEntry, codexRollout, metaHeader, req } from './helpers/hub-harness.js';

const win32 = platform() === 'win32';
const KEY = 'git:' + 'd'.repeat(40);

let sandbox: string;
let restore: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

function deps(): PushIngestDeps & { embeds: string[]; lines: string[]; refused: string[] } {
  const embeds: string[] = []; const lines: string[] = []; const refused: string[] = [];
  return {
    embeds, lines, refused,
    spawnEmbed: (id) => { embeds.push(id); },
    log: (l) => { lines.push(l); },
    onRefused: (h) => { refused.push(h); },
  };
}

/** Write a mirror file + sidecar for host/vendor/rel; return the job. */
function stageMirror(host: string, rel: string, body: string, meta: PushIngestJob['meta'], vendor: 'claude' | 'codex' = 'claude'): PushIngestJob {
  const abs = mirrorFilePath(host, vendor, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  writeSidecar(abs, { host, ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}), ...(meta.key !== undefined ? { key: meta.key } : {}), ...(meta.hook ? { hook: meta.hook } : {}), updatedAt: new Date().toISOString(), v: 1 });
  const st = statSync(abs);
  return { host, vendor, rel, abs, mtimeInt: Math.floor(st.mtimeMs), size: st.size, meta, reset: false };
}

/** A two-commit git repository under the sandbox. Returns its path. */
function makeGitRepo(name: string): string {
  const repo = join(sandbox, name);
  mkdirSync(repo, { recursive: true });
  const g = (args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: repo, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'f.txt'), 'content\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'c0']);
  clearProjectKeyCache();
  return repo;
}

function rootCommitOf(repo: string): string {
  return execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .split('\n')[0]!.trim();
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

function snapshot(): string {
  return JSON.stringify(getDb(dbPath()).all('SELECT session_id, project_id, project_key FROM messages ORDER BY message_id'));
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-hub-ingest-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_REMOTE_ROOT', 'RECALL_HOME']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = join(sandbox, 'claude');
  process.env['CODEX_HOME'] = join(sandbox, 'codex');
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, '.recall', 'remote');
  mkdirSync(join(sandbox, 'claude', 'projects', 'local'), { recursive: true });
  mkdirSync(join(sandbox, 'codex'), { recursive: true });
  _resetDb();
});

afterAll(() => {
  restore?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => { _resetDb(); });

describe('sandbox guard', () => {
  it('recallRoot() and remoteRoot() sit under tmpdir before any write', () => {
    expect(resolve(recallRoot()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(remoteRoot()).startsWith(resolve(tmpdir()))).toBe(true);
  });
});

describe.skipIf(win32)('runPushIngest (§2.4)', () => {
  it('ingests WITH hook context: satellite key + cwd stamped, watermark keyed on the mirror path, embed spawned once', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-u-proj/${sid}.jsonl`;
    const job = stageMirror('sat1', rel, claudeEntry(sid, 0, 'hooked turn, long enough to clear the fifty character embedding floor', { cwd: '/home/u/proj' }), {
      cwd: '/home/u/proj', key: KEY, hook: { isSubagent: false, payloadSessionId: sid },
    });
    const d = deps();
    expect(await runPushIngest(job, d)).toBe('ingested');
    const db = getDb(dbPath());
    expect(db.all('SELECT project_id, project_key FROM messages WHERE session_id = ?', [sid])).toEqual([{ project_id: '/home/u/proj', project_key: KEY }]);
    expect(db.get('SELECT transcript_path, last_mtime, last_size, vendor FROM ingest_watermark WHERE transcript_path = ?', [job.abs]))
      .toEqual({ transcript_path: job.abs, last_mtime: job.mtimeInt, last_size: job.size, vendor: 'claude' });
    expect(db.get('SELECT kind, transcript_path FROM session_provenance WHERE session_id = ?', [sid])).toEqual({ kind: 'root', transcript_path: job.abs });
    expect(d.embeds).toEqual([sid]);
    expect(d.refused).toEqual([]);
    expect(d.lines.some((l) => l.startsWith('push-ingested host=sat1'))).toBe(true);
  });

  it('upgrades a sidecar path: key the HUB owns to the repository key (U3)', async () => {
    // A Windows satellite reached this repository through `\\\\wsl$\\Ubuntu\\…`,
    // so it could key only the path. The hub owns the directory and knows the
    // repository — one physical repo must keep one key.
    const repo = makeGitRepo('wsl-repo');
    const sid = randomUUID();
    const rel = `projects/-wsl-repo/${sid}.jsonl`;
    const job = stageMirror('silverera2', rel, claudeEntry(sid, 0, 'a windows turn on a wsl repository, long enough to clear the floor', { cwd: repo }), {
      cwd: repo, key: `path:${repo}`,
    });
    const d = deps();
    expect(await runPushIngest(job, d)).toBe('ingested');
    expect(getDb(dbPath()).get('SELECT project_key FROM messages WHERE session_id = ?', [sid]))
      .toEqual({ project_key: `git:${rootCommitOf(repo)}` });
    expect(d.lines.some((l) => l.startsWith('key-upgraded host=silverera2')
      && l.includes(`from=path:${repo}`) && l.includes(`to=git:${rootCommitOf(repo)}`))).toBe(true);
  });

  it('leaves a path: key for a directory the hub does not own unchanged', async () => {
    const sid = randomUUID();
    const rel = `projects/-gone/${sid}.jsonl`;
    const job = stageMirror('silverera2', rel, claudeEntry(sid, 0, 'a turn from a path this hub never had, long enough to clear it', { cwd: '/home/u/gone' }), {
      cwd: '/home/u/gone', key: 'path:/home/u/gone',
    });
    const d = deps();
    expect(await runPushIngest(job, d)).toBe('ingested');
    expect(getDb(dbPath()).get('SELECT project_key FROM messages WHERE session_id = ?', [sid]))
      .toEqual({ project_key: 'path:/home/u/gone' });
    expect(d.lines.some((l) => l.startsWith('key-upgraded'))).toBe(false);
  });

  it('the mirror SWEEP upgrades the same sidecar key', async () => {
    const repo = makeGitRepo('wsl-repo-sweep');
    const sid = randomUUID();
    const rel = `projects/-wsl-repo-sweep/${sid}.jsonl`;
    // Staged on disk with a sidecar, but never pushed: the sweep ingests it.
    stageMirror('silverera2', rel, claudeEntry(sid, 0, 'a swept windows turn on a wsl repository, long enough to clear it', { cwd: repo }), {
      cwd: repo, key: `path:${repo}`,
    });
    const r = await runMirrorSweep();
    expect(r.ingested).toBeGreaterThanOrEqual(1);
    expect(getDb(dbPath()).get('SELECT project_key FROM messages WHERE session_id = ?', [sid]))
      .toEqual({ project_key: `git:${rootCommitOf(repo)}` });
  });

  it('ingests WITHOUT hook context: cwd from the transcript, key from the sidecar, never derived', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-u-proj/${sid}.jsonl`;
    const job = stageMirror('sat1', rel, claudeEntry(sid, 0, 'plain turn, long enough to clear the fifty character embedding floor', { cwd: '/home/u/other' }), {});
    // Sidecar carries a key but the request meta did not — the sidecar path wins.
    writeSidecar(job.abs, { host: 'sat1', cwd: '/home/u/other', key: 'path:/home/u/other', updatedAt: 'x', v: 1 });
    expect(await runPushIngest(job, deps())).toBe('ingested');
    expect(getDb(dbPath()).all('SELECT project_id, project_key FROM messages WHERE session_id = ?', [sid]))
      .toEqual([{ project_id: '/home/u/other', project_key: 'path:/home/u/other' }]);
  });

  it('does NOT spawn embed-pending for a SubagentStop push or an agent leaf', async () => {
    const parent = randomUUID();
    const leaf = `agent-${randomUUID().slice(0, 7)}`;
    const rel = `projects/-home-u-proj/${parent}/subagents/${leaf}.jsonl`;
    const hooked = stageMirror('sat1', rel, claudeEntry(leaf, 0, 'subagent leaf turn, long enough to clear the fifty character floor', { cwd: '/home/u/proj' }), {
      cwd: '/home/u/proj', hook: { isSubagent: true, payloadSessionId: parent, agentId: leaf },
    });
    const d1 = deps();
    expect(await runPushIngest(hooked, d1)).toBe('ingested');
    expect(d1.embeds).toEqual([]);
    expect(getDb(dbPath()).get('SELECT kind FROM session_provenance WHERE session_id = ?', [leaf])).toEqual({ kind: 'agent' });

    const leaf2 = `agent-${randomUUID().slice(0, 7)}`;
    const rel2 = `projects/-home-u-proj/${randomUUID()}/subagents/${leaf2}.jsonl`;
    const noHook = stageMirror('sat1', rel2, claudeEntry(leaf2, 0, 'leaf without hook, long enough to clear the fifty character floor', { cwd: '/home/u/proj' }), { cwd: '/home/u/proj' });
    const d2 = deps();
    expect(await runPushIngest(noHook, d2)).toBe('ingested');
    expect(d2.embeds).toEqual([]);
  });

  it('refuses a session-id collision: bytes kept, rows and provenance byte-identical, one log line, refusedCollisions++', async () => {
    // A hub-LOCAL session under the Claude home owns this id first.
    const sid = randomUUID();
    const local = join(process.env['CLAUDE_CONFIG_DIR']!, 'projects', 'local', `${sid}.jsonl`);
    writeFileSync(local, claudeEntry(sid, 0, 'hub-local original turn, long enough to clear the fifty character floor', { cwd: '/hub/proj' }));
    const first = await ingestSessionMessages(sid, local, 'claude', { projectId: '/hub/proj', projectKey: 'path:/hub/proj' });
    expect(first.error).toBeUndefined();
    const db = getDb(dbPath());
    const before = JSON.stringify({
      m: db.all('SELECT * FROM messages WHERE session_id = ? ORDER BY message_id', [sid]),
      p: db.all('SELECT * FROM session_provenance WHERE session_id = ?', [sid]),
    });
    // The satellite pushes a DIFFERENT transcript with the same id.
    const rel = `projects/-sat-proj/${sid}.jsonl`;
    const job = stageMirror('sat1', rel, claudeEntry(sid, 0, 'satellite imposter turn, long enough to clear the fifty character floor', { uuid: `${sid}-other-0` }), { cwd: '/sat/proj', key: 'path:/sat/proj' });
    job.reset = true; // even a reset (force) must never delete the hub's rows
    const d = deps();
    expect(await runPushIngest(job, d)).toBe('refused');
    const after = JSON.stringify({
      m: db.all('SELECT * FROM messages WHERE session_id = ? ORDER BY message_id', [sid]),
      p: db.all('SELECT * FROM session_provenance WHERE session_id = ?', [sid]),
    });
    expect(after).toBe(before);
    expect(existsSync(job.abs)).toBe(true);
    expect(db.get('SELECT 1 AS x FROM ingest_watermark WHERE transcript_path = ?', [job.abs])).toBeUndefined();
    const collisionLines = d.lines.filter((l) => l.startsWith('session-id collision host=sat1'));
    expect(collisionLines).toHaveLength(1);
    expect(collisionLines[0]).toContain(`sid=${sid}`);
    expect(collisionLines[0]).toContain(`existing=${local.replace(/\\/g, '/')}`);
    expect(d.refused).toEqual(['sat1']);
    expect(d.embeds).toEqual([]);
    // The sweep applies the same guard: the refused file is never merged.
    const sweep = await runMirrorSweep();
    // A refusal is PERMANENT, so it is counted apart from `failed` (retry me).
    expect(sweep.refused).toBe(1);
    expect(sweep.failed).toBe(0);
    expect(JSON.stringify({
      m: db.all('SELECT * FROM messages WHERE session_id = ? ORDER BY message_id', [sid]),
      p: db.all('SELECT * FROM session_provenance WHERE session_id = ?', [sid]),
    })).toBe(before);
    expect(db.get('SELECT 1 AS x FROM ingest_watermark WHERE transcript_path = ?', [job.abs])).toBeUndefined();
    const collisionLine = () => readFileSync(join(recallRoot(), 'logs', 'hub.log'), 'utf-8')
      .split('\n').filter((l) => l.includes(`sid=${sid}`) && l.includes('source=scan'));
    expect(collisionLine()).toHaveLength(1);
    // A second sweep reports the same refusal and adds NO new log line: a
    // permanent refusal must not spam hub.log every five minutes.
    const second = await runMirrorSweep();
    expect(second.refused).toBe(1);
    expect(second.failed).toBe(0);
    expect(collisionLine()).toHaveLength(1);
  });

  it('a same-host re-push of a known session is not a collision', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-u-proj/${sid}.jsonl`;
    const job = stageMirror('sat1', rel, claudeEntry(sid, 0, 'same host first push, long enough to clear the fifty character floor', { cwd: '/home/u/proj' }), { cwd: '/home/u/proj' });
    expect(await runPushIngest(job, deps())).toBe('ingested');
    writeFileSync(job.abs, readFileSync(job.abs, 'utf-8') + claudeEntry(sid, 1, 'same host second push, long enough to clear the fifty character floor', { cwd: '/home/u/proj' }));
    const st = statSync(job.abs);
    const again = { ...job, mtimeInt: Math.floor(st.mtimeMs), size: st.size };
    const d = deps();
    expect(await runPushIngest(again, d)).toBe('ingested');
    expect(d.refused).toEqual([]);
    expect(getDb(dbPath()).get('SELECT COUNT(*) c FROM messages WHERE session_id = ?', [sid])).toEqual({ c: 2 });
  });

  it('watermark is NOT written when the ingest fails, and the next sweep ingests it', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-u-proj/${sid}.jsonl`;
    const job = stageMirror('sat1', rel, claudeEntry(sid, 0, 'fails first, sweeps later, long enough to clear the fifty character floor', { cwd: '/home/u/proj' }), { cwd: '/home/u/proj' });
    const abs = job.abs;
    const db = getDb(dbPath());
    // Make the insert throw: the ingest must report failure and leave no watermark.
    db.exec(`CREATE TRIGGER hub_test_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const d = deps();
    try {
      expect(await runPushIngest(job, d)).toBe('failed');
    } finally {
      db.exec('DROP TRIGGER hub_test_fail');
    }
    expect(d.lines.some((l) => l.startsWith('push-ingest-failed host=sat1') && l.includes('boom'))).toBe(true);
    expect(d.embeds).toEqual([]);
    expect(db.get('SELECT 1 AS x FROM ingest_watermark WHERE transcript_path = ?', [abs])).toBeUndefined();
    expect(db.get('SELECT COUNT(*) c FROM messages WHERE session_id = ?', [sid])).toEqual({ c: 0 });
    const r = await runMirrorSweep();
    expect(r.ingested).toBeGreaterThanOrEqual(1);
    expect(db.get('SELECT 1 AS x FROM ingest_watermark WHERE transcript_path = ?', [abs])).toEqual({ x: 1 });
    expect(db.get('SELECT COUNT(*) c FROM messages WHERE session_id = ?', [sid])).toEqual({ c: 1 });
  });
});

describe.skipIf(win32)('sweep, mtimeScan roots, repair --full (§2.5)', () => {
  it('sweep after a clean push reports unchanged; key preserved across a re-ingesting sweep AND repair --full', async () => {
    const sid = randomUUID();
    const rel = `projects/-home-u-proj/${sid}.jsonl`;
    // Tiny bodies keep the embedding gap at 0 so repair --full's autoEmbed never spawns a backend.
    const job = stageMirror('sat1', rel, claudeEntry(sid, 0, 'tiny', { cwd: '/home/u/proj' }), { cwd: '/home/u/proj', key: KEY });
    expect(await runPushIngest(job, deps())).toBe('ingested');
    const snap = snapshot();
    expect(snap).toContain(KEY);

    const wmBefore = getDb(dbPath()).get('SELECT last_mtime, last_size FROM ingest_watermark WHERE transcript_path = ?', [job.abs]);
    const clean = await runMirrorSweep();
    expect(clean.scanned).toBeGreaterThanOrEqual(1);
    expect(clean.unchanged).toBeGreaterThanOrEqual(1);
    expect(clean.ingested).toBe(0);
    expect(getDb(dbPath()).get('SELECT last_mtime, last_size FROM ingest_watermark WHERE transcript_path = ?', [job.abs])).toEqual(wmBefore);

    // Force a re-ingest through the sweep (mtime bump, no options passed).
    const future = new Date(Date.now() + 5000);
    utimesSync(job.abs, future, future);
    const again = await runMirrorSweep();
    expect(again.ingested).toBeGreaterThanOrEqual(1);
    expect(snapshot()).toBe(snap);

    // repair --full: prints the host list, deletes, re-ingests the mirror with the sidecar key intact.
    const r = await repairFull({ yes: true });
    expect(r.refused).toBe(false);
    expect(r.mirrorHosts).toContain('sat1');
    expect(snapshot()).toBe(snap); // keys intact AND the refused collision file was not merged by the catch-up
    expect(existsSync(`${job.abs}.meta.json`)).toBe(true);
    const wm = getDb(dbPath()).get('SELECT vendor FROM ingest_watermark WHERE transcript_path = ?', [job.abs]);
    expect(wm).toEqual({ vendor: 'claude' });
    expect(mirrorRoots().some((m) => m.root === mirrorVendorRoot('sat1', 'claude') && m.vendor === 'claude')).toBe(true);
  });

  it('mtimeScan roots take the vendor from the root (codex mirror ingested as codex)', async () => {
    const sid = randomUUID();
    const rel = `sessions/2026/09/04/rollout-2026-09-04T00-00-00-${sid}.jsonl`;
    const abs = mirrorFilePath('cdx', 'codex', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, codexRollout(sid, 'codex mirror turn, long enough to clear the fifty character embedding floor'));
    const r = await mtimeScan({ roots: [{ root: mirrorVendorRoot('cdx', 'codex'), vendor: 'codex' }] });
    expect(r.ingested).toBe(1);
    const db = getDb(dbPath());
    expect(db.get('SELECT vendor FROM ingest_watermark WHERE transcript_path = ?', [abs])).toEqual({ vendor: 'codex' });
    expect(db.get('SELECT vendor FROM session_provenance WHERE session_id = ?', [sid])).toEqual({ vendor: 'codex' });
    expect(db.get('SELECT COUNT(*) c FROM messages WHERE session_id = ? AND message_id LIKE ?', [sid, `codex-jsonl-${sid}-%`])).toEqual({ c: 2 });
    // roots REPLACE the home roots: the local claude session is not scanned.
    expect(r.scanned).toBe(1);
  });

  it('repair --full refuses (exit path) when remoteRoot() exists with zero mirror roots and touches nothing', async () => {
    const sid = randomUUID();
    const local = join(process.env['CLAUDE_CONFIG_DIR']!, 'projects', 'local', `${sid}.jsonl`);
    writeFileSync(local, claudeEntry(sid, 0, 'tiny', { cwd: '/hub/proj' }));
    await ingestSessionMessages(sid, local, 'claude');
    const db = getDb(dbPath());
    const before = (db.get('SELECT COUNT(*) c FROM messages') as { c: number }).c;
    expect(before).toBeGreaterThan(0);
    const emptyRemote = join(sandbox, 'empty-remote');
    mkdirSync(join(emptyRemote, 'ghost-host'), { recursive: true }); // a host dir with no vendor dir
    const prev = process.env['RECALL_REMOTE_ROOT'];
    process.env['RECALL_REMOTE_ROOT'] = emptyRemote;
    try {
      expect(mirrorRoots()).toEqual([]);
      const r = await repairFull({ yes: true });
      expect(r.refused).toBe(true);
      expect((db.get('SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(before);
    } finally {
      process.env['RECALL_REMOTE_ROOT'] = prev;
    }
  });
});

describe.skipIf(win32)('in-process daemon: collision through the wire increments hub-hosts.json', () => {
  it('refusedCollisions++ and exactly one hub.log line', async () => {
    const sid = randomUUID();
    const local = join(process.env['CLAUDE_CONFIG_DIR']!, 'projects', 'local', `${sid}.jsonl`);
    writeFileSync(local, claudeEntry(sid, 0, 'hub-local owner, long enough to clear the fifty character embedding floor', { cwd: '/hub/proj' }));
    await ingestSessionMessages(sid, local, 'claude');
    const token = issueHubToken('wirehost');
    const h = await startHubServer({ bind: '127.0.0.1', port: 0, sweepMs: null, startupSweep: false, spawnEmbed: () => { /* never */ } });
    try {
      const url = `http://127.0.0.1:${h.port}`;
      const body = claudeEntry(sid, 0, 'imposter over the wire, long enough to clear the fifty character floor', { uuid: `${sid}-w0` });
      const r = await req(url, { method: 'PUT', path: appendPath('claude', `projects/-w/${sid}.jsonl`, 0), headers: authHeaders(token, { 'x-recall-meta': metaHeader({ cwd: '/w', final: true }) }), body });
      expect(r.status).toBe(200);
      await h.queue.idle(5_000);
    } finally {
      await h.stop();
    }
    const hosts = JSON.parse(readFileSync(join(recallRoot(), 'run', 'hub-hosts.json'), 'utf-8'));
    expect(hosts.wirehost.refusedCollisions).toBe(1);
    const log = readFileSync(join(recallRoot(), 'logs', 'hub.log'), 'utf-8').split('\n').filter((l) => l.includes(`session-id collision host=wirehost sid=${sid}`));
    expect(log).toHaveLength(1);
    expect(getDb(dbPath()).get('SELECT COUNT(*) c FROM messages WHERE session_id = ?', [sid])).toEqual({ c: 1 });
  }, 20_000);
});

describe.skipIf(win32)('doctor hub section', () => {
  it('warns on a mirror with no live daemon and on an ANY bind', () => {
    mkdirSync(transcriptGlob(remoteRoot(), 'sat9', 'claude', 'projects', 'p'), { recursive: true });
    writeFileSync(transcriptGlob(remoteRoot(), 'sat9', 'claude', 'projects', 'p', 'no-sidecar.jsonl'), 'x\n');
    writeHubConfig({ bind: '', port: 7877, installedAt: 'x' });
    _resetDb();
    const h = checkHubHealth();
    expect(h.daemonAlive).toBe(false);
    expect(h.bindIsAny).toBe(true);
    expect(h.hosts.find((x) => x.host === 'sat9')).toMatchObject({ files: 1, sidecarless: 1 });
    expect(h.warnings.some((w) => w.includes('recall hub serve'))).toBe(true);
    expect(h.warnings.some((w) => w.includes('every interface'))).toBe(true);
  });

  it('reports collisions from the refusal evidence the daemon persists, naming the host and the ids', () => {
    // The earlier suites in this file left both artifacts behind: the
    // in-process daemon incremented `refusedCollisions` for `wirehost`, and
    // the sweep guard wrote `session-id collision … source=scan` to hub.log.
    const hosts = JSON.parse(readFileSync(join(recallRoot(), 'run', 'hub-hosts.json'), 'utf-8')) as Record<string, { refusedCollisions: number }>;
    expect(hosts['wirehost']!.refusedCollisions).toBe(1);
    const logIds = readFileSync(join(recallRoot(), 'logs', 'hub.log'), 'utf-8')
      .split('\n').filter((l) => /session-id collision host=/.test(l))
      .map((l) => /sid=(\S+)/.exec(l)![1]!);
    expect(logIds.length).toBeGreaterThan(0);

    const h = checkHubHealth();
    expect(h.collisions.refusedByHost).toEqual([{ host: 'wirehost', count: 1 }]);
    expect(h.collisions.logLines).toBe(logIds.length);
    expect(h.collisions.recentSessionIds).toEqual(logIds.slice(-5));
    expect(h.collisions.logLinesTruncated).toBe(false); // the fixture log is far under the tail window
    expect(hasCollisionEvidence(h.collisions)).toBe(true);
    const warning = h.warnings.find((w) => w.includes('refused as session-id collisions'));
    expect(warning).toBeDefined();
    expect(warning).toContain('wirehost');
    expect(warning).toContain(logIds[logIds.length - 1]!);
    // The printed section names the evidence too.
    const printed = capture(() => printHub(h));
    expect(printed).toContain('Collisions:');
    expect(printed).toContain('wirehost');
  });

  it('a purely LOCAL duplicate session id is not reported as a collision', () => {
    // Two transcripts of one `agent-<hex>` id under different project
    // directories, BOTH under the Claude home and neither under remoteRoot():
    // that is a local duplicate-subagent-id (spec §10, R-c2vs0c), not an S11
    // cross-host collision. The removed DB cross-check reported 15 of these
    // as collisions on a healthy hub; the refusal-evidence report must not.
    const dupId = 'agent-dup0001';
    const claudeHome = process.env['CLAUDE_CONFIG_DIR']!;
    const one = `${claudeHome}/projects/proj-a/${dupId}.jsonl`.replace(/\\/g, '/');
    const two = `${claudeHome}/projects/proj-b/${dupId}.jsonl`.replace(/\\/g, '/');
    const db = getDb(dbPath());
    db.run(
      `INSERT OR REPLACE INTO session_provenance (session_id, vendor, kind, transcript_path, updated_at)
       VALUES (?, 'claude', 'agent', ?, ?)`,
      [dupId, one, Date.now()],
    );
    for (const p of [one, two]) {
      db.run(
        `INSERT OR REPLACE INTO ingest_watermark (transcript_path, last_mtime, last_size, vendor)
         VALUES (?, 1, 1, 'claude')`,
        [p],
      );
    }
    _resetDb();

    const before = readCollisionEvidence();
    const h = checkHubHealth();
    expect(h.hosts.length).toBeGreaterThan(0); // the gate the cross-check used to open on
    // The report is unchanged by the local pair: same counts, same ids.
    expect(h.collisions).toEqual(before);
    expect(h.warnings.some((w) => w.includes(dupId))).toBe(false);
    expect(capture(() => printHub(h))).not.toContain(dupId);
  });

  it('reads only the hub.log tail, drops the partial first line, and labels a truncated count with ≥', () => {
    // hub.log is append-only and unrotated (a line per request and per sweep),
    // so the report reads the last HUB_LOG_TAIL_BYTES only. Pad past the
    // window, then append three collision lines: everything older — including
    // this suite's earlier collision lines — falls outside it.
    const logFile = join(recallRoot(), 'logs', 'hub.log');
    const pad = `${new Date().toISOString()} append host=padhost path=projects/-pad/x.jsonl offset=0 bytes=1 size=1\n`;
    appendFileSync(logFile, pad.repeat(Math.ceil((HUB_LOG_TAIL_BYTES * 1.5) / pad.length)));
    const tailIds = ['tail-sid-1', 'tail-sid-2', 'tail-sid-3'];
    for (const sid of tailIds) {
      appendFileSync(logFile, `${new Date().toISOString()} session-id collision host=tailhost sid=${sid} existing=/elsewhere/x.jsonl source=scan\n`);
    }
    expect(statSync(logFile).size).toBeGreaterThan(HUB_LOG_TAIL_BYTES);

    const c = readCollisionEvidence();
    expect(c.logLinesTruncated).toBe(true);
    expect(c.logLines).toBe(tailIds.length); // older collision lines are outside the window
    expect(c.recentSessionIds).toEqual(tailIds);
    // The dropped first element was a fragment, never a half-parsed line.
    expect(c.recentSessionIds.every((id) => tailIds.includes(id))).toBe(true);

    const h = checkHubHealth();
    const printed = capture(() => printHub(h));
    expect(printed).toContain(`Collisions:     ≥${tailIds.length} logged`);
  });
});
