/**
 * `buildHubArgv` — the hub's argv gate (L5) and the forwarded project key (M3).
 *
 * Pure-function suite: nothing here spawns, opens a database or touches
 * `recallRoot()`, so no sandbox env is needed. Every key used is one that
 * cannot resolve to a real directory, so `upgradeLocalPathKey` never reaches
 * `git` on the machine running the tests.
 */
import { describe, expect, it } from 'vitest';
import { buildHubArgv } from '../../src/hub/query.js';

const REPO_KEY = 'git:' + 'a'.repeat(40);

/** A `path:` key naming a directory that certainly does not exist here. */
const UNOWNED = 'path:/definitely/not/a/directory/on/this/host-8f3c1e';

function ok(argv: string[], extra: { cwd?: string; key?: string } = {}): string[] {
  const r = buildHubArgv({ argv, cwd: extra.cwd ?? '/home/u/proj', ...(extra.key ? { key: extra.key } : {}) });
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.argv;
}

function fail(argv: string[]): string {
  const r = buildHubArgv({ argv, cwd: '/home/u/proj' });
  if (r.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(r.argv)}`);
  return r.reason;
}

describe('buildHubArgv — L5: the value slot is not a hole in the allowlist', () => {
  it('rejects a flag smuggled into the slot after --limit', () => {
    // The exploit: `--commit` is NOT on QUERY_FLAG_ALLOWLIST, but as the value
    // token of `--limit` it used to be pushed through unchecked and then read
    // by the CHILD's own `hasFlag('--commit')`.
    expect(fail(['q', '--limit', '--commit'])).toMatch(/must not begin with -/);
    expect(fail(['q', '--limit', '--commit'])).toContain('--limit');
  });

  it('rejects the same smuggling after every value flag', () => {
    for (const flag of ['--limit', '--offset', '--since', '--until']) {
      expect(fail(['q', flag, '--commit'])).toMatch(/must not begin with -/);
      // A short flag is refused too — the rule is the leading `-`, not `--`.
      expect(fail(['q', flag, '-x'])).toMatch(/must not begin with -/);
    }
  });

  it('rejects a smuggled --project / --project-key, which would break the sole-writer-of-scope rule', () => {
    expect(fail(['q', '--limit', '--project-key'])).toMatch(/must not begin with -/);
  });

  it('still accepts ordinary values, including ones containing a dash', () => {
    expect(ok(['q', '--limit', '7'])).toContain('7');
    expect(ok(['q', '--since', '2026-01-02'])).toContain('2026-01-02');
    expect(ok(['q', 'a-b-c'])).toContain('a-b-c');
  });
});

describe('buildHubArgv — M3: the forwarded key is upgraded, not echoed raw', () => {
  it('forwards a git: key unchanged', () => {
    const argv = ok(['q'], { key: REPO_KEY });
    expect(argv[argv.indexOf('--project-key') + 1]).toBe(REPO_KEY);
  });

  it('forwards a path: key the hub does not own unchanged', () => {
    const argv = ok(['q'], { key: UNOWNED });
    expect(argv[argv.indexOf('--project-key') + 1]).toBe(UNOWNED);
  });

  it('appends no --project-key at all when the request carries none', () => {
    expect(ok(['q'])).toEqual(['q', '--project', '/home/u/proj', '--no-catchup']);
  });

  it('appends neither scope flag under --all', () => {
    expect(ok(['q', '--all'], { key: REPO_KEY })).toEqual(['q', '--all', '--no-catchup']);
  });
});
