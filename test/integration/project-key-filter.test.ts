/**
 * The five project-scope filter sites (spec §4.4, S3) — result sets only.
 *
 * The predicate is `(project_key = ? OR project_id = ?)`, so a scoped search
 * returns every session of the same repository AND every row a key alone would
 * miss: rows written by an older binary, rows not yet re-keyed, and mixed-case
 * Windows project_ids. No query plan is asserted here — each site's ORDER BY /
 * GROUP BY / rowid-join shape legitimately picks another index (the index
 * itself is proven in project-key-schema.test.ts).
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import {
  grepMessages, projectScopeSql, searchMessagesFts, searchMessagesFtsMeta, searchMessagesSemantic,
} from '../../src/recall/message-store.js';
import { listSessions } from '../../src/recall/memory-queries.js';
import { EMBED_VERSION } from '../../src/recall/embed-config.js';
import { clearProjectKeyCache } from '../../src/recall/project-key.js';

const KEY = 'git:aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const WIN_ID = 'c:/WinDev/Proj';
const WIN_KEY = 'path:c:/windev/proj';
const TERM = 'wolverine';
const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

const SEEDS: Array<{ sid: string; projectId: string; key: string | null }> = [
  { sid: 'S1', projectId: '/x/one', key: KEY },
  { sid: 'S2', projectId: '/x/two', key: KEY },
  { sid: 'S3', projectId: '/x/three', key: null },
  { sid: 'S4', projectId: WIN_ID, key: null },
];

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let prevRemote: string | undefined;

function seed(): void {
  const d = getDb(dbPath());
  const blob = Buffer.alloc(768, 1);
  let seq = 0;
  for (const s of SEEDS) {
    for (let i = 0; i < 2; i++) {
      const mid = `${s.sid}-m${i}`;
      d.run(
        `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class, project_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'hot', ?)`,
        [mid, s.sid, i, `${TERM} narration for ${s.sid}${PAD}`, s.projectId, 1000 + seq++, 'assistant', s.key],
      );
      d.run(
        `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version)
         VALUES (?, ?, 1.0, 1.0, ?)`,
        [mid, blob, EMBED_VERSION],
      );
    }
  }
}

function sids(rows: Array<{ session_id: string }>): string[] {
  return [...new Set(rows.map((r) => r.session_id))].sort();
}

function semantic(projectId?: string, projectKey?: string): string[] {
  const q = new Int8Array(768).fill(1);
  return sids(searchMessagesSemantic(q, 1.0, 1.0, {
    limit: 50,
    ...(projectId ? { projectId } : {}),
    ...(projectKey ? { projectKey } : {}),
  }));
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-pkey-filter-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
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
  if (prevRemote === undefined) delete process.env['RECALL_REMOTE_ROOT'];
  else process.env['RECALL_REMOTE_ROOT'] = prevRemote;
  if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
});

describe('projectScopeSql', () => {
  it('emits a BARE predicate and pushes its binds in order', () => {
    const p: (string | number)[] = [];
    expect(projectScopeSql('m', undefined, undefined, p)).toBe('');
    expect(p).toEqual([]);

    const p2: (string | number)[] = [];
    expect(projectScopeSql('m', '/x/one', undefined, p2)).toBe('m.project_id = ?');
    expect(p2).toEqual(['/x/one']);

    const p3: (string | number)[] = [];
    expect(projectScopeSql('m', '/x/one', KEY, p3)).toBe('(m.project_key = ? OR m.project_id = ?)');
    expect(p3).toEqual([KEY, '/x/one']);

    const p4: (string | number)[] = [];
    expect(projectScopeSql(null, undefined, KEY, p4)).toBe('project_key = ?');
    expect(p4).toEqual([KEY]);
  });
});

describe.skipIf(platform() === 'win32')('all five sites scope by key OR path', () => {
  it('listSessions', () => {
    expect(listSessions(dbPath(), 50, undefined, undefined, '/x/one', undefined, KEY)
      .map((r) => r.session_id).sort()).toEqual(['S1', 'S2']);
    expect(listSessions(dbPath(), 50, undefined, undefined, '/x/three')
      .map((r) => r.session_id).sort()).toEqual(['S3']);
    expect(listSessions(dbPath(), 50, undefined, undefined, WIN_ID, undefined, WIN_KEY)
      .map((r) => r.session_id).sort()).toEqual(['S4']);
  });

  it('searchMessagesFts', () => {
    expect(sids(searchMessagesFts(TERM, 50, '/x/one', undefined, undefined, undefined, KEY)))
      .toEqual(['S1', 'S2']);
    expect(sids(searchMessagesFts(TERM, 50, '/x/three'))).toEqual(['S3']);
    expect(sids(searchMessagesFts(TERM, 50, WIN_ID, undefined, undefined, undefined, WIN_KEY)))
      .toEqual(['S4']);
  });

  it('searchMessagesFtsMeta', () => {
    expect(Object.keys(searchMessagesFtsMeta(TERM, '/x/one', undefined, undefined, KEY).session_hits).sort())
      .toEqual(['S1', 'S2']);
    expect(Object.keys(searchMessagesFtsMeta(TERM, '/x/three').session_hits).sort()).toEqual(['S3']);
    expect(Object.keys(searchMessagesFtsMeta(TERM, WIN_ID, undefined, undefined, WIN_KEY).session_hits).sort())
      .toEqual(['S4']);
  });

  it('grepMessages', () => {
    expect(sids(grepMessages(TERM, 50, undefined, '/x/one', undefined, KEY))).toEqual(['S1', 'S2']);
    expect(sids(grepMessages(TERM, 50, undefined, '/x/three'))).toEqual(['S3']);
    expect(sids(grepMessages(TERM, 50, undefined, WIN_ID, undefined, WIN_KEY))).toEqual(['S4']);
  });

  it('searchMessagesSemantic', () => {
    expect(semantic('/x/one', KEY)).toEqual(['S1', 'S2']);
    expect(semantic('/x/three')).toEqual(['S3']);
    expect(semantic(WIN_ID, WIN_KEY)).toEqual(['S4']);
  });
});
