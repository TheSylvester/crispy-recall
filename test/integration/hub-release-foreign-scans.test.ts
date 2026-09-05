/**
 * `recall hub release-foreign-scans` (U2 item 2).
 *
 * Reproduces the 2026-09-05 defect in miniature: a provenance row that names a
 * `/mnt/c/…` path a hub process scanned under `CODEX_HOME`, while the very same
 * session sits in the satellite mirror. The release drops the provenance row
 * and the local watermark ONLY — the messages stay, because the mirror path
 * re-adopts the session on the next sweep.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40). This suite spawns
 * nothing and never signals a real process: `kill` is injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getDb, type RecallDb } from '../../src/db.js';
import { writeSatelliteConfig } from '../../src/installer/config.js';
import { _setTestRoot, dbPath, recallRoot, remoteRoot } from '../../src/paths.js';
import {
  STALE_RECORD_MS, hubRecordPath, readHostRecords, updateHostRecord, type HostRecord,
} from '../../src/hub/runtime.js';
import { findForeignScans, runReleaseForeignScans } from '../../src/hub/cli.js';

const FOREIGN_SID = '01a06e2c-2146-71c2-97a3-a3044d56d2fe';
const ORPHAN_SID = '01a06e2c-2146-71c2-97a3-a3044d56d2ff';
const MIRRORED_SID = '01a06e2c-2146-71c2-97a3-a3044d56d2fa';
// A stolen Codex SUBAGENT: the rollout filename carries one uuid, the
// session_meta carries the canonical one that provenance stores.
const SUB_RAW_SID = '01a06e2c-2146-71c2-97a3-a3044d56d2fb';
const SUB_CANON_SID = '01a06e2c-2146-71c2-97a3-a3044d56d2fc';
const FOREIGN_LOCAL = `/mnt/c/Users/silve/.codex/sessions/2026/09/05/rollout-2026-09-05T20-47-45-${FOREIGN_SID}.jsonl`;

let sandbox: string;
let restore: (() => void) | undefined;
let db: RecallDb;
let prevRemote: string | undefined;
let logs: string[];
let errors: string[];

function provenance(sid: string, path: string): void {
  db.run(
    `INSERT INTO session_provenance (session_id, vendor, kind, transcript_path, updated_at)
     VALUES (?, 'codex', 'main', ?, ?)`,
    [sid, path, Date.now()],
  );
}

function watermark(path: string): void {
  db.run(
    `INSERT INTO ingest_watermark (transcript_path, last_mtime, last_size, vendor) VALUES (?, 1, 1, 'codex')`,
    [path],
  );
}

function mirrorFile(host: string, sid: string, meta?: Record<string, unknown>): string {
  const abs = join(remoteRoot(), host, 'codex', 'sessions', '2026', '09', '05',
    `rollout-2026-09-05T20-47-45-${sid}.jsonl`);
  mkdirSync(dirname(abs), { recursive: true });
  const body = meta
    ? JSON.stringify({ timestamp: '2026-09-05T20:47:45.000Z', type: 'session_meta', payload: meta }) + '\n'
    : '{}\n';
  writeFileSync(abs, body);
  return abs.replace(/\\/g, '/');
}

/** A hub.json naming `pid`, `ageMs` old. */
function daemonRecord(pid: number, ageMs = 0): void {
  mkdirSync(dirname(hubRecordPath()), { recursive: true });
  writeFileSync(hubRecordPath(), JSON.stringify({
    pid, bind: '127.0.0.1', port: 7877, startedAt: new Date().toISOString(),
    lockToken: 'x', ts: Date.now() - ageMs, v: 1,
  }));
}

/** A fake process table: `<procRoot>/<pid>/cmdline`. */
function fakeProc(pid: number, cmdline: string): string {
  const root = join(sandbox, 'proc');
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), 'cmdline'), cmdline.replace(/ /g, '\0'));
  return root;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-release-'));
  prevRemote = process.env['RECALL_REMOTE_ROOT'];
  delete process.env['RECALL_REMOTE_ROOT'];
  restore = _setTestRoot(join(sandbox, '.recall'));
  mkdirSync(dirname(dbPath()), { recursive: true });
  db = getDb(dbPath());

  // (a) the stolen session: a /mnt/c path AND a mirror file.
  provenance(FOREIGN_SID, FOREIGN_LOCAL);
  watermark(FOREIGN_LOCAL);
  mirrorFile('silverera2', FOREIGN_SID);
  db.run(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at)
     VALUES ('m1', ?, 1, 'kept', 1)`,
    [FOREIGN_SID],
  );

  // (b) a /mnt/c path with NO mirror file — nothing to hand back to.
  provenance(ORPHAN_SID, `/mnt/c/Users/silve/.codex/sessions/2026/09/05/rollout-x-${ORPHAN_SID}.jsonl`);

  // (c) a session already owned by the mirror, and (d) one in the default root.
  const mirrored = mirrorFile('silverera2', MIRRORED_SID);
  provenance(MIRRORED_SID, mirrored);
  provenance('local-sid', join(homedir(), '.codex', 'sessions', '2026', '09', '05', 'rollout-y-local-sid.jsonl'));

  logs = [];
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* already closed */ }
  restore?.(); restore = undefined;
  if (prevRemote === undefined) delete process.env['RECALL_REMOTE_ROOT'];
  else process.env['RECALL_REMOTE_ROOT'] = prevRemote;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('hub release-foreign-scans', () => {
  it('selects only the env-override row that the mirror can re-adopt', () => {
    const rows = findForeignScans();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe(FOREIGN_SID);
    expect(rows[0]!.localPath).toBe(FOREIGN_LOCAL);
    expect(rows[0]!.host).toBe('silverera2');
    expect(rows[0]!.mirrorPath).toContain(`/silverera2/codex/sessions/2026/09/05/`);
  });

  it('lists the row and changes nothing without --yes', () => {
    expect(runReleaseForeignScans()).toBe(0);
    expect(logs.join('\n')).toContain(`release sid=${FOREIGN_SID} local=${FOREIGN_LOCAL} mirror=`);
    expect(logs.join('\n')).toContain('Re-run with --yes to apply');
    expect(db.all('SELECT 1 FROM session_provenance WHERE session_id = ?', [FOREIGN_SID])).toHaveLength(1);
    expect(db.all('SELECT 1 FROM ingest_watermark WHERE transcript_path = ?', [FOREIGN_LOCAL])).toHaveLength(1);
  });

  it('--yes deletes both rows, keeps the messages and signals the live daemon', () => {
    daemonRecord(process.pid);
    const procRoot = fakeProc(process.pid, `node ${join(recallRoot(), 'bin', 'recall.js')} hub serve`);
    const kill = vi.fn();
    expect(runReleaseForeignScans({ apply: true, kill, procRoot })).toBe(0);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGUSR1');
    expect(logs.join('\n')).toContain(`sweep requested pid=${process.pid}`);

    expect(db.all('SELECT 1 FROM session_provenance WHERE session_id = ?', [FOREIGN_SID])).toHaveLength(0);
    expect(db.all('SELECT 1 FROM ingest_watermark WHERE transcript_path = ?', [FOREIGN_LOCAL])).toHaveLength(0);
    expect(db.all('SELECT message_id FROM messages WHERE session_id = ?', [FOREIGN_SID])).toHaveLength(1);
    // The other three rows are untouched.
    expect(db.all('SELECT 1 FROM session_provenance')).toHaveLength(3);
    expect(findForeignScans()).toHaveLength(0);
  });

  it('says so when no daemon is running', () => {
    const kill = vi.fn();
    expect(runReleaseForeignScans({ apply: true, kill })).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('daemon not running: the next sweep adopts them');
  });
});

describe('hub release-foreign-scans — the daemon must be the one we recorded', () => {
  it('refuses to signal a stale record (a pid can be recycled across a reboot)', () => {
    daemonRecord(process.pid, STALE_RECORD_MS + 1000);
    const procRoot = fakeProc(process.pid, `node ${join(recallRoot(), 'bin', 'recall.js')} hub serve`);
    const kill = vi.fn();
    expect(runReleaseForeignScans({ apply: true, kill, procRoot })).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('daemon not running: the next sweep adopts them');
  });

  it('refuses to signal a pid whose cmdline is not recall.js', () => {
    daemonRecord(process.pid);
    const procRoot = fakeProc(process.pid, '/usr/bin/some-other-daemon --serve');
    const kill = vi.fn();
    expect(runReleaseForeignScans({ apply: true, kill, procRoot })).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('daemon not running: the next sweep adopts them');
  });
});

describe('hub release-foreign-scans — canonical ids', () => {
  it('matches a stolen subagent by its canonical id, not the rollout filename', () => {
    // The mirror file is named for SUB_RAW_SID; session_meta names the
    // canonical SUB_CANON_SID, which is what the sweep stored as provenance.
    const local = `/mnt/c/Users/silve/.codex/sessions/2026/09/05/rollout-x-${SUB_RAW_SID}.jsonl`;
    provenance(SUB_CANON_SID, local);
    mirrorFile('silverera2', SUB_RAW_SID, {
      id: SUB_CANON_SID,
      cwd: '/proj',
      source: { subagent: { thread_spawn: { parent_thread_id: MIRRORED_SID, depth: 1, agent_type: 'explorer' } } },
    });

    const rows = findForeignScans();
    expect(rows.map((r) => r.sessionId).sort()).toEqual([FOREIGN_SID, SUB_CANON_SID].sort());
    const sub = rows.find((r) => r.sessionId === SUB_CANON_SID)!;
    expect(sub.mirrorPath).toContain(SUB_RAW_SID);
    expect(sub.host).toBe('silverera2');
  });
});

describe('hub release-foreign-scans — satellite guard', () => {
  let satSandbox: string;
  let satRestore: (() => void) | undefined;

  beforeEach(() => {
    satSandbox = mkdtempSync(join(tmpdir(), 'recall-release-sat-'));
    satRestore = _setTestRoot(join(satSandbox, '.recall'));
    writeSatelliteConfig({ hubUrl: 'http://hub.example:7877', host: 'sat1', installedAt: new Date().toISOString() });
  });

  afterEach(() => {
    satRestore?.(); satRestore = undefined;
    rmSync(satSandbox, { recursive: true, force: true });
  });

  it('refuses, and never creates a local recall.db', () => {
    expect(runReleaseForeignScans({ apply: true, kill: vi.fn() })).toBe(1);
    expect(errors.join('\n')).toContain('not available in satellite mode');
    expect(existsSync(dbPath())).toBe(false);
  });
});

describe('hub release-foreign-scans — the refusal counter', () => {
  /** Seed a host record straight into hub-hosts.json. */
  function seedHost(host: string, rec: Partial<HostRecord>): void {
    updateHostRecord(host, (c) => ({ ...c, ...rec }));
  }

  const LAST_PUSH = '2026-09-05T20:00:00.000Z';

  beforeEach(() => {
    seedHost('silverera2', { refusedCollisions: 3, refusedRecent: ['x'], lastPushAt: LAST_PUSH });
    seedHost('otherbox', { refusedCollisions: 2, refusedRecent: ['y'] });
  });

  it('--yes clears the counter of every host that got rows back, and says so', () => {
    expect(runReleaseForeignScans({ apply: true, kill: vi.fn() })).toBe(0);
    expect(logs.join('\n')).toContain('refusals cleared host=silverera2');

    const rec = readHostRecords()['silverera2']!;
    expect(rec.refusedCollisions).toBe(0);
    expect(rec.refusedRecent).toEqual([]);
    // Clearing the refusals must not forget the rest of the record.
    expect(rec.lastPushAt).toBe(LAST_PUSH);
  });

  it('leaves a host with no released rows alone', () => {
    expect(runReleaseForeignScans({ apply: true, kill: vi.fn() })).toBe(0);
    expect(logs.join('\n')).not.toContain('refusals cleared host=otherbox');

    const rec = readHostRecords()['otherbox']!;
    expect(rec.refusedCollisions).toBe(2);
    expect(rec.refusedRecent).toEqual(['y']);
  });

  it('a dry run clears nothing', () => {
    expect(runReleaseForeignScans()).toBe(0);
    expect(logs.join('\n')).not.toContain('refusals cleared');

    const rec = readHostRecords()['silverera2']!;
    expect(rec.refusedCollisions).toBe(3);
    expect(rec.refusedRecent).toEqual(['x']);
  });
});
