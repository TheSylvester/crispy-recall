/**
 * `recall doctor` project-key line (spec §4.3).
 *
 * The backfill notice is WARN-only: unkeyed rows still match through the
 * project_id half of the filter, so search stays correct and the exit code
 * must not move. This locks both halves — the reported flag and the fact that
 * it never enters `problems` (doctor.ts:68 `bindingFailed`).
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import Database from 'better-sqlite3';

import { _setTestRoot, binDir, dbPath } from '../../src/paths.js';
import { _resetDb, getDb, PROJECT_KEY_BACKFILL_KEY } from '../../src/db.js';
import { checkBindingHealth, printBinding } from '../../src/installer/doctor.js';

const NOTICE = 'Project keys: backfill pending — run: recall repair --rekey-projects';
const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

let sandbox: string;
let restore: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

/** A DB with a `messages` table and one row. The marker is removed by default. */
function seedDb(withMarker: boolean): void {
  const d = getDb(dbPath());
  d.run(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class)
     VALUES ('m0','s0',0,?, '/x/one', 1000, 'user', 'hot')`,
    [`doctor fixture narration${PAD}`],
  );
  d.run('DELETE FROM schema_meta WHERE key = ?', [PROJECT_KEY_BACKFILL_KEY]);
  if (withMarker) {
    d.run(`INSERT INTO schema_meta(key, value) VALUES (?, 'complete')`, [PROJECT_KEY_BACKFILL_KEY]);
  }
  _resetDb();
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-doctor-pkey-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_HOME', 'RECALL_REMOTE_ROOT']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = join(sandbox, 'claude');
  process.env['CODEX_HOME'] = join(sandbox, 'codex');
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, '.recall', 'remote');
  mkdirSync(binDir(), { recursive: true });
  // `installed` is gated on a staged bundle (doctor.ts:130-135).
  writeFileSync(join(binDir(), 'recall.js'), '// bundle');
  _resetDb();
});

afterEach(() => {
  restore?.(); restore = undefined;
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('checkBindingHealth — project-key backfill', () => {
  it('messages table, no marker → pending true, printed, and NO new problem', () => {
    seedDb(false);
    const before = checkBindingHealth();
    expect(before.projectKeyBackfillPending).toBe(true);
    expect(before.problems.filter((p) => /project key/i.test(p))).toEqual([]);
    expect(capture(() => printBinding(before))).toContain(NOTICE);
  });

  it('marker complete → pending false and the line is absent', () => {
    seedDb(true);
    const h = checkBindingHealth();
    expect(h.projectKeyBackfillPending).toBe(false);
    expect(capture(() => printBinding(h))).not.toContain(NOTICE);
  });

  it('no messages table at all → null, and the line is absent', () => {
    // A bare DB file with no recall schema — never opened through getDb.
    const raw = new Database(dbPath());
    raw.exec('CREATE TABLE unrelated (x INTEGER)');
    raw.close();

    const h = checkBindingHealth();
    expect(h.projectKeyBackfillPending).toBeNull();
    expect(capture(() => printBinding(h))).not.toContain(NOTICE);
  });
});
