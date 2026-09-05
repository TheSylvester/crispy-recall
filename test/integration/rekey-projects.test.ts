/**
 * `recall repair --rekey-projects` (spec §4.3) — the attended project-key backfill.
 *
 * Locks the four contract points: local project_ids get keyed, MIRROR-ONLY
 * project_ids are left alone (their rows carry the key their satellite
 * derived), the FTS triggers dropped for the mass UPDATE come back intact, and
 * the durable marker is written ONLY when nothing was left NULL.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, dbPath, remoteRoot } from '../../src/paths.js';
import { _resetDb, getDb, PROJECT_KEY_BACKFILL_KEY } from '../../src/db.js';
import { repairRekeyProjects } from '../../src/installer/repair.js';
import { clearProjectKeyCache } from '../../src/recall/project-key.js';

const MIRROR_KEY = 'git:bbbb1111bbbb2222cccc3333dddd4444eeee5555';
const MIRROR_PROJECT = '/home/sylvester/dev/crispy';
const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let prevPath: string | undefined;
let prevRemote: string | undefined;

function insertMessage(sid: string, mid: string, projectId: string, key: string | null): void {
  getDb(dbPath()).run(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class, project_key)
     VALUES (?, ?, 0, ?, ?, ?, 'assistant', 'hot', ?)`,
    [mid, sid, `rekey fixture narration for ${sid}${PAD}`, projectId, Date.now(), key],
  );
}

function provenance(sid: string, transcriptPath: string): void {
  getDb(dbPath()).run(
    `INSERT INTO session_provenance (session_id, vendor, kind, parent_session_id, agent_depth, agent_meta, transcript_path, updated_at)
     VALUES (?, 'claude', 'root', NULL, NULL, NULL, ?, ?)`,
    [sid, transcriptPath, Date.now()],
  );
}

function keyOf(sid: string): string | null {
  const row = getDb(dbPath()).get(
    'SELECT project_key FROM messages WHERE session_id = ? LIMIT 1', [sid],
  ) as { project_key: string | null } | undefined;
  return row?.project_key ?? null;
}

function marker(): string | undefined {
  const row = getDb(dbPath()).get(
    'SELECT value FROM schema_meta WHERE key = ?', [PROJECT_KEY_BACKFILL_KEY],
  ) as { value?: string } | undefined;
  return row?.value;
}

function triggerNames(): string[] {
  return (getDb(dbPath()).all(
    `SELECT name FROM sqlite_master WHERE type='trigger'`,
  ) as Array<{ name: string }>).map((r) => r.name).sort();
}

/** Seed the S1-S4 local rows (keyed NULL) plus one mirror-only session. */
function seed(): void {
  getDb(dbPath());
  insertMessage('S1', 'S1-m0', '/x/one', null);
  insertMessage('S2', 'S2-m0', '/x/two', null);
  insertMessage('S3', 'S3-m0', '/x/three', null);
  insertMessage('S4', 'S4-m0', 'c:/WinDev/Proj', null);

  const mirrorFile = join(remoteRoot(), 'sylvester-laptop', 'claude', 'projects', '-home-sylvester-dev-crispy', `${randomUUID()}.jsonl`);
  mkdirSync(join(mirrorFile, '..'), { recursive: true });
  writeFileSync(mirrorFile, '{}\n');
  insertMessage('M1', 'M1-m0', MIRROR_PROJECT, MIRROR_KEY);
  provenance('M1', mirrorFile);

  // The fresh-DB marker is written by ensureSchema; clear it so the fixture
  // models a real pre-existing database with unkeyed rows.
  getDb(dbPath()).run('DELETE FROM schema_meta WHERE key = ?', [PROJECT_KEY_BACKFILL_KEY]);
}

/** Install a fake `git` first on PATH that always fails transiently. */
function fakeTransientGit(): void {
  const dir = mkdtempSync(join(recallHome, 'fakegit-'));
  const script = join(dir, 'git');
  writeFileSync(script, '#!/bin/sh\nkill -TERM $$\nsleep 30\nexit 0\n', { mode: 0o755 });
  chmodSync(script, 0o755);
  process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-rekey-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  prevPath = process.env['PATH'];
  prevRemote = process.env['RECALL_REMOTE_ROOT'];
  process.env['RECALL_REMOTE_ROOT'] = join(recallHome, 'remote');
  clearProjectKeyCache();
  _resetDb();
  seed();
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

describe.skipIf(platform() === 'win32')('repairRekeyProjects', () => {
  it('keys local rows, skips mirror-only ids, restores the FTS triggers, writes the marker', () => {
    const r = repairRekeyProjects({ force: false });

    expect(r.projectIds).toBe(4);
    expect(r.updated).toBe(4);
    expect(r.skippedMirror).toBe(1);
    expect(r.transient).toBe(0);
    expect(r.markerWritten).toBe(true);

    // Vanished local directories still key by their path, exactly as they scoped before.
    expect(keyOf('S1')).toBe('path:/x/one');
    expect(keyOf('S2')).toBe('path:/x/two');
    expect(keyOf('S3')).toBe('path:/x/three');
    // A Windows-SHAPED project_id folds on the Linux hub exactly as it does
    // on the satellite that wrote it.
    expect(keyOf('S4')).toBe('path:c:/windev/proj');
    // The mirror row keeps the key its satellite derived.
    expect(keyOf('M1')).toBe(MIRROR_KEY);

    expect(triggerNames()).toEqual(['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au'].sort());
    const objects = (getDb(dbPath()).all(
      `SELECT name FROM sqlite_master WHERE name IN ('searchable_messages','messages_fts','messages_fts_vocab')`,
    ) as Array<{ name: string }>).map((x) => x.name).sort();
    expect(objects).toEqual(['messages_fts', 'messages_fts_vocab', 'searchable_messages']);
    expect(() => getDb(dbPath()).exec(
      "INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1);",
    )).not.toThrow();

    expect(marker()).toBe('complete');
  });

  it('is idempotent, and --force re-keys an already-keyed local row', () => {
    repairRekeyProjects({ force: false });
    const second = repairRekeyProjects({ force: false });
    expect(second.updated).toBe(0); // nothing left NULL
    expect(second.markerWritten).toBe(true);

    // A stale key is only corrected under --force.
    getDb(dbPath()).run(`UPDATE messages SET project_key = 'path:/stale' WHERE session_id = 'S1'`);
    expect(repairRekeyProjects({ force: false }).updated).toBe(0);
    expect(keyOf('S1')).toBe('path:/stale');

    const forced = repairRekeyProjects({ force: true });
    expect(forced.updated).toBeGreaterThan(0);
    expect(keyOf('S1')).toBe('path:/x/one');
    // --force never reaches a mirror-only project_id.
    expect(keyOf('M1')).toBe(MIRROR_KEY);
  });

  it('rewrites a \\\\wsl$ UNC key without --force, upgrading the ones the hub owns', () => {
    // A Windows satellite working on a WSL repository keyed the mount it saw,
    // not the repository. Two rows: one whose POSIX path this hub owns, one
    // whose path is gone.
    const repo = join(recallHome, 'wsl-repo');
    mkdirSync(repo, { recursive: true });
    const g = (args: string[]) => execFileSync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd: repo, encoding: 'utf8' }).trim();
    g(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'content\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'c0']);
    const root = g(['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]!.trim();
    clearProjectKeyCache();

    insertMessage('W1', 'W1-m0', `//wsl$/Ubuntu${repo}`, `path://wsl$/ubuntu${repo.toLowerCase()}`);
    insertMessage('W2', 'W2-m0', '//wsl.localhost/Ubuntu/home/silver/dev/gone', 'path://wsl.localhost/ubuntu/home/silver/dev/gone');

    const r = repairRekeyProjects({ force: false });
    expect(r.wslRows).toBe(2);
    expect(r.wslUpgraded).toBe(1);
    expect(r.wslPathOnly).toBe(1);
    expect(keyOf('W1')).toBe(`git:${root}`);
    expect(keyOf('W2')).toBe('path:/home/silver/dev/gone');

    // A second run finds nothing left to rewrite.
    const second = repairRekeyProjects({ force: false });
    expect(second.wslRows).toBe(0);
  }, 30_000);

  it('a transient derivation leaves the rows NULL, the marker absent, and markerWritten false', () => {
    // A project_id that EXISTS on disk is the only one that reaches git.
    const live = join(recallHome, 'live-project');
    mkdirSync(live, { recursive: true });
    insertMessage('S5', 'S5-m0', live, null);
    fakeTransientGit();

    const r = repairRekeyProjects({ force: false });
    expect(r.transient).toBe(1);
    expect(r.markerWritten).toBe(false);
    expect(keyOf('S5')).toBeNull();
    // The other project_ids were still keyed — the run is partial, not aborted.
    expect(keyOf('S1')).toBe('path:/x/one');
    expect(marker()).toBeUndefined();
  }, 30_000);
});
