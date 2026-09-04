/**
 * Mirror sidecar stamping (spec S12 / §4.2 rule b).
 *
 * A mirrored transcript names a cwd that does not exist on the hub, so
 * `deriveProjectKey` must NEVER run for it: the key comes from the sidecar the
 * push handler wrote, and a missing or malformed sidecar means a NULL key —
 * never a guess. The rule has to hold for the option-less ingest paths too
 * (the sweep, `backfill`, `repair --full`), which is the whole reason the key
 * is persisted on disk rather than recomputed.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, dbPath, remoteRoot } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { normalizePath } from '../../src/url-path-resolver.js';
import { clearProjectKeyCache } from '../../src/recall/project-key.js';
import { readMirrorMeta } from '../../src/recall/mirror-meta.js';

const HOST = 'sylvester-laptop';
const SAT_CWD = '/home/sylvester/dev/crispy';
const SAT_KEY = 'git:bbbb1111bbbb2222cccc3333dddd4444eeee5555';
const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let prevPath: string | undefined;
let prevRemote: string | undefined;
let gitMarker: string;

/** A `git` first on PATH that only records that it ran. */
function fakeGit(): void {
  const dir = join(recallHome, 'fakegit');
  mkdirSync(dir, { recursive: true });
  gitMarker = join(recallHome, 'git-ran.log');
  const script = join(dir, 'git');
  writeFileSync(script, `#!/bin/sh\necho "$*" >> "${gitMarker}"\nexit 128\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
}

function gitRan(): boolean {
  return existsSync(gitMarker) && readFileSync(gitMarker, 'utf8').trim().length > 0;
}

/** Write a mirrored Claude transcript; `sidecar` is written verbatim when given. */
function writeMirrored(sid: string, sidecar: string | undefined): string {
  const dir = join(remoteRoot(), HOST, 'claude', 'projects', '-home-sylvester-dev-crispy');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  const entries = [
    { type: 'user', uuid: `${sid}-m0`, parentUuid: null, sessionId: sid, cwd: SAT_CWD,
      timestamp: '2026-05-01T10:00:00.000Z',
      message: { role: 'user', content: `mirrored fixture prompt${PAD}` } },
    { type: 'assistant', uuid: `${sid}-m1`, parentUuid: `${sid}-m0`, sessionId: sid, cwd: SAT_CWD,
      timestamp: '2026-05-01T10:00:01.000Z',
      message: { role: 'assistant', content: `mirrored fixture reply${PAD}` } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (sidecar !== undefined) writeFileSync(`${file}.meta.json`, sidecar);
  return file;
}

function rowsFor(sid: string): Array<{ project_id: string | null; project_key: string | null }> {
  return getDb(dbPath()).all(
    'SELECT DISTINCT project_id, project_key FROM messages WHERE session_id = ?', [sid],
  ) as Array<{ project_id: string | null; project_key: string | null }>;
}

function snapshot(): string {
  return JSON.stringify(getDb(dbPath()).all(
    'SELECT session_id, project_id, project_key FROM messages ORDER BY message_id',
  ));
}

const goodSidecar = JSON.stringify({
  host: HOST, cwd: SAT_CWD, key: SAT_KEY, updatedAt: '2026-05-01T10:00:02.000Z', v: 1,
});

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-mirror-meta-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  prevPath = process.env['PATH'];
  prevRemote = process.env['RECALL_REMOTE_ROOT'];
  process.env['RECALL_REMOTE_ROOT'] = join(recallHome, 'remote');
  clearProjectKeyCache();
  _resetDb();
  getDb(dbPath());
  fakeGit();
});

afterEach(() => {
  restoreRoot?.(); restoreRoot = undefined;
  _resetDb();
  clearProjectKeyCache();
  if (prevPath === undefined) delete process.env['PATH']; else process.env['PATH'] = prevPath;
  if (prevRemote === undefined) delete process.env['RECALL_REMOTE_ROOT'];
  else process.env['RECALL_REMOTE_ROOT'] = prevRemote;
  if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('mirrored ingest reads the sidecar, never git', () => {
  it('a valid sidecar stamps its key on every row, with no git spawn', async () => {
    const sid = randomUUID();
    const file = writeMirrored(sid, goodSidecar);
    expect(readMirrorMeta(file)?.key).toBe(SAT_KEY);

    const res = await ingestSessionMessages(sid, file, 'claude');
    expect(res.error).toBeUndefined();
    expect(rowsFor(sid)).toEqual([{ project_id: normalizePath(SAT_CWD), project_key: SAT_KEY }]);
    expect(gitRan()).toBe(false);
  });

  const bad: Array<[string, string | undefined]> = [
    ['absent', undefined],
    ['unparseable JSON', '{ not json at all'],
    ['a foreign version', JSON.stringify({ host: HOST, cwd: SAT_CWD, key: SAT_KEY, updatedAt: 'x', v: 2 })],
    ['a non-string key', JSON.stringify({ host: HOST, cwd: SAT_CWD, key: 42, updatedAt: 'x', v: 1 })],
  ];
  for (const [label, body] of bad) {
    it(`a sidecar that is ${label} → NULL key, still no git spawn`, async () => {
      const sid = randomUUID();
      const file = writeMirrored(sid, body);
      const res = await ingestSessionMessages(sid, file, 'claude');
      expect(res.error).toBeUndefined();
      expect(rowsFor(sid)).toEqual([{ project_id: normalizePath(SAT_CWD), project_key: null }]);
      expect(gitRan()).toBe(false);
    });
  }

  it('an explicit projectKey: null on a LOCAL transcript stores NULL and derives nothing', async () => {
    // The Stop hook passes null when its own derivation failed transiently.
    // Ingest must respect that, not retry the derivation it already lost.
    const sid = randomUUID();
    const cwd = join(recallHome, 'local-project');
    mkdirSync(cwd, { recursive: true });
    const file = join(cwd, `${sid}.jsonl`);
    const entries = [
      { type: 'user', uuid: `${sid}-m0`, parentUuid: null, sessionId: sid, cwd,
        timestamp: '2026-05-01T10:00:00.000Z',
        message: { role: 'user', content: `local fixture prompt${PAD}` } },
      { type: 'assistant', uuid: `${sid}-m1`, parentUuid: `${sid}-m0`, sessionId: sid, cwd,
        timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'assistant', content: `local fixture reply${PAD}` } },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const res = await ingestSessionMessages(sid, file, 'claude', { projectId: cwd, projectKey: null });
    expect(res.error).toBeUndefined();
    expect(rowsFor(sid)).toEqual([{ project_id: normalizePath(cwd), project_key: null }]);
    expect(gitRan()).toBe(false);
  });

  it('a second option-less ingest (the sweep / repair --full path) changes nothing', async () => {
    const sid = randomUUID();
    const file = writeMirrored(sid, goodSidecar);
    await ingestSessionMessages(sid, file, 'claude');
    const before = snapshot();

    await ingestSessionMessages(sid, file, 'claude');
    expect(snapshot()).toBe(before);
    expect(gitRan()).toBe(false);
  });
});
