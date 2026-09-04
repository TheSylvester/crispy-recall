/**
 * `temp._stem` scratch on an INSTALLER-MODE open (spec S14 + db.ts).
 *
 * `getDb(path, { allowPendingMigration: true })` returns early for an
 * old-generation DB, skipping `ensureSchema`. The `temp.` stem scratch must
 * still be created on that branch: it touches no persistent object, and
 * without it `fts5Stem` throws `no such table: temp._stem`, swallows the
 * throw and returns the UNSTEMMED lowercase word — which silently breaks
 * every IDF document-frequency lookup the migration path performs.
 *
 * In-process rule: this suite calls `getDb` in-process, so it first calls
 * `_setTestRoot(join(<tmp>, '.recall'))` and sets CLAUDE_CONFIG_DIR,
 * CODEX_HOME and RECALL_REMOTE_ROOT to temp dirs (restored afterwards).
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, dbPath, recallRoot, remoteRoot } from '../../src/paths.js';
import { _resetDb, getDb, RETRIEVAL_MIGRATION_KEY } from '../../src/db.js';
import { fts5Stem, sanitizeFts5Query } from '../../src/recall/query-sanitizer.js';

const win32 = platform() === 'win32';
let sandbox: string;
let restore: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-stem-installer-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_REMOTE_ROOT']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = join(sandbox, 'claude');
  process.env['CODEX_HOME'] = join(sandbox, 'codex');
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, '.recall', 'remote');
  _resetDb();
});

afterAll(() => {
  restore?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(win32)('stem scratch on an installer-mode open', () => {
  it('sandbox guard', () => {
    expect(resolve(recallRoot()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(remoteRoot()).startsWith(resolve(tmpdir()))).toBe(true);
  });

  it('fts5Stem stems, and the IDF filter drops a high-frequency term, on a pending-migration connection', () => {
    // Build a current-schema DB, then remove the retrieval marker so the next
    // open looks old-generation and takes the installer-mode early return.
    const fresh = getDb(dbPath());
    fresh.run('DELETE FROM schema_meta WHERE key = ?', [RETRIEVAL_MIGRATION_KEY]);
    _resetDb();

    const d = getDb(dbPath(), { allowPendingMigration: true });
    // Proof this really is the early-return branch: a normal open fails closed.
    _resetDb();
    expect(() => getDb(dbPath())).toThrowError(/migration/i);
    _resetDb();
    const pending = getDb(dbPath(), { allowPendingMigration: true });
    expect(pending).toBeDefined();
    void d;

    // 1. The stemmer works on this connection (it would return 'running' if
    //    `temp._stem` were missing and the throw were swallowed).
    expect(fts5Stem('running')).toBe('run');
    expect(fts5Stem('connections')).toBe('connect');

    // 2. …and the IDF filter that depends on it behaves: `running` appears in
    //    every indexed message, so the 3+ word path drops it while the two
    //    rare terms survive. With a broken stemmer the vocab lookup for the
    //    unstemmed word finds nothing and the term is wrongly KEPT.
    for (let i = 0; i < 10; i++) {
      pending.run(
        `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
         VALUES (?, 'stem-sess', ?, ?, NULL, ?, 'user', 'hot')`,
        [`m-${i}-${randomUUID().slice(0, 8)}`, i, `running shared text number ${i}`, 1_700_000_000_000 + i],
      );
    }
    const out = sanitizeFts5Query('running zorptangle wibblenax');
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('running');
    expect(out!.toLowerCase()).toContain('zorptangle');
    expect(out!.toLowerCase()).toContain('wibblenax');
  });
});
