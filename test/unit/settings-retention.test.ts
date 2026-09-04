/**
 * ensureCleanupPeriodDays — the satellite retention pin (spec §3.1, Retention).
 *
 * A satellite's transcript files ARE the push spool, so Claude Code's
 * `cleanupPeriodDays` is the hard loss window. The table asserted here: absent
 * or below the floor → raised with a backup; at or above → untouched and no
 * backup; non-numeric or an unparseable file → untouched with a warning.
 *
 * Isolation — in-process: every new suite that calls `runInstall`, `runDoctor`,
 * `getStatus`, `runUninstall` or `runPreflight` IN-PROCESS MUST first call
 * `restore = _setTestRoot(join(<tmp>, '.recall'))` (restore it in
 * afterAll/afterEach) AND set `process.env.CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
 * `RECALL_REMOTE_ROOT` to temp dirs (restoring the previous values), exactly as
 * test/unit/preflight-node-version.test.ts:25-38 and
 * test/integration/manifest-optout.test.ts:33-54 do.
 * Isolation — spawned children: `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`.
 * (This suite writes only to files inside its own temp dir.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureCleanupPeriodDays } from '../../src/installer/settings-merge.js';

let sandbox: string;
let settings: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-retention-'));
  settings = join(sandbox, 'settings.json');
});
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

function baks(): string[] {
  return readdirSync(sandbox).filter((f) => f.startsWith('settings.json.bak.'));
}
function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(settings, 'utf-8')) as Record<string, unknown>;
}

describe('ensureCleanupPeriodDays', () => {
  it('creates the file when settings.json is absent (no backup to take)', () => {
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(true);
    expect(r.backup).toBeUndefined();
    expect(read()['cleanupPeriodDays']).toBe(999);
  });

  it('adds the key when absent from an existing file, keeping siblings', () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }, null, 2));
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(true);
    expect(r.backup).toBeTruthy();
    expect(baks()).toHaveLength(1);
    expect(read()).toMatchObject({ model: 'opus', cleanupPeriodDays: 999 });
  });

  it('raises a value below the floor and backs up first', () => {
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30 }));
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(true);
    expect(baks()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(sandbox, baks()[0]!), 'utf-8')).cleanupPeriodDays).toBe(30);
    expect(read()['cleanupPeriodDays']).toBe(999);
  });

  it('leaves the floor value alone and takes no backup', () => {
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 999 }));
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(false);
    expect(baks()).toHaveLength(0);
    expect(read()['cleanupPeriodDays']).toBe(999);
  });

  it('leaves a longer window alone and takes no backup', () => {
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 1000 }));
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(false);
    expect(baks()).toHaveLength(0);
    expect(read()['cleanupPeriodDays']).toBe(1000);
  });

  it('never rewrites a non-numeric value — it warns instead', () => {
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 'abc' }));
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(false);
    expect(r.warning).toMatch(/not a number/);
    expect(baks()).toHaveLength(0);
    expect(read()['cleanupPeriodDays']).toBe('abc');
  });

  it('never rewrites an unparseable settings file — it warns instead', () => {
    writeFileSync(settings, '{ this is not json');
    const r = ensureCleanupPeriodDays(settings, 999);
    expect(r.changed).toBe(false);
    expect(r.warning).toMatch(/not parseable/);
    expect(readFileSync(settings, 'utf-8')).toBe('{ this is not json');
  });
});
