/**
 * Static lint of the spec §9 acceptance scripts under `contrib/satellite/e2e/`.
 *
 * The scripts drive the owner's REAL machines, so this suite never executes a
 * script body: it spawns `bash -n` (a syntax check) and otherwise reads text.
 * It encodes the rules that keep an acceptance run safe — read-only access to
 * the live database except one allow-listed watermark DELETE, no token literal,
 * no bare `ssh`/`cmd.exe`, a restore trap on every state-changing script, and a
 * README run order that names exactly the scripts on disk.
 *
 * Isolation — spawned children: `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`; a child that
 * inherits the parent env resolves `recallRoot()` to the live `~/.recall`
 * (paths.ts:35-40). (This suite spawns only `bash -n`, which needs no root —
 * but the rule stays.)
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', '..', 'contrib', 'satellite', 'e2e');
const SCRIPTS = readdirSync(DIR).filter((f) => f.endsWith('.sh')).sort();
const RUNNABLE = SCRIPTS.filter((f) => f !== 'lib.sh');
const NEEDS_LIB = RUNNABLE.filter((f) => f !== '10-parity.sh');
const WINDOWS_SCRIPTS = ['50-win-install.sh', '51-win-sessions.sh', '52-win-queries.sh', '90-teardown.sh'];
const STATE_CHANGING = ['33-hub-hardening.sh', '44-laptop-failures.sh', '50-win-install.sh', '60-hub-repair-full-snapshot.sh'];
const HELPERS = [
  'pass', 'fail', 'step', 'load_tokens', 'nonce', 'hub_sql', 'lap', 'lap_put', 'lap_stdin',
  'win_cmd', 'wait_until', 'hub_health', 'require_hub_up', 'mirror_dir', 'log_file', 'write_token_file',
];

const text = (f: string) => readFileSync(join(DIR, f), 'utf8');
const lines = (f: string) => text(f).split('\n');
/** Lines with the leading `#` comments dropped (heredoc bodies are kept). */
const code = (f: string) => lines(f).filter((l) => !/^\s*#/.test(l));

describe('contrib/satellite/e2e — script lint', () => {
  it('finds the whole script set', () => {
    expect(SCRIPTS).toContain('lib.sh');
    expect(SCRIPTS).toContain('10-parity.sh');
    expect(RUNNABLE.length).toBeGreaterThanOrEqual(22);
  });

  it.each(SCRIPTS)('%s passes bash -n', (f) => {
    expect(() => execFileSync('bash', ['-n', join(DIR, f)], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(SCRIPTS)('%s sets -u', (f) => {
    expect(text(f)).toMatch(/^set -u$/m);
  });

  it.each(NEEDS_LIB)('%s sources lib.sh', (f) => {
    expect(text(f)).toContain('source "$(dirname "$0")/lib.sh"');
  });

  it.each(RUNNABLE)('%s reports exactly one outcome vocabulary', (f) => {
    const t = text(f);
    if (f === '10-parity.sh') {
      expect(t).toContain('PASS ');
      expect(t).toContain('FAIL ');
    } else {
      expect(t).toMatch(/\bpass "/);
      expect(t).toMatch(/\bfail "/);
    }
  });

  // Rule 10: no token literal may ever be committed.
  it.each(SCRIPTS)('%s carries no 64-hex literal', (f) => {
    const hit = lines(f).findIndex((l) => /[0-9a-f]{64}/.test(l));
    expect(hit === -1 ? '' : `${f}:${hit + 1}: ${lines(f)[hit]}`).toBe('');
  });

  // Every remote call goes through the audited helpers.
  it.each(RUNNABLE)('%s makes no bare ssh or cmd.exe call', (f) => {
    for (const [i, l] of code(f).entries()) {
      expect(l, `${f} line ${i + 1}`).not.toMatch(/(^|[^\w-])ssh /);
      expect(l, `${f} line ${i + 1}`).not.toMatch(/cmd\.exe/);
    }
  });

  it.each(SCRIPTS)('%s puts no double quote on a cmd.exe /c line', (f) => {
    for (const l of lines(f)) {
      const at = l.indexOf('cmd.exe /c');
      if (at >= 0) expect(l.slice(at).includes('"'), `${f}: ${l.trim()}`).toBe(false);
    }
  });

  it.each(WINDOWS_SCRIPTS)('%s writes well-formed .cmd bodies', (f) => {
    const t = text(f);
    const bodies = [...t.matchAll(/<<'?CMD'?\n([\s\S]*?)\nCMD\b/g)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const b of bodies) {
      expect(b).toContain('@echo off');
      expect(b).toContain('exit /b %ERRORLEVEL%');
    }
  });

  // Rule 5 of the brief: the live database is read-only, with ONE exception.
  it.each(SCRIPTS)('%s touches the live database read-only', (f) => {
    for (const [i, l] of lines(f).entries()) {
      if (!/sqlite3/.test(l) || !/\.recall\/recall\.db/.test(l)) continue;
      const allowed =
        f === '44-laptop-failures.sh' &&
        l.includes("DELETE FROM ingest_watermark WHERE transcript_path='");
      if (allowed) continue;
      expect(l, `${f} line ${i + 1}`).toMatch(/-readonly/);
      expect(l, `${f} line ${i + 1}`).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
    }
  });

  it('only 44-laptop-failures.sh writes to the live database', () => {
    const writers = SCRIPTS.filter((f) =>
      lines(f).some((l) => /sqlite3/.test(l) && /\.recall\/recall\.db/.test(l) && !/-readonly/.test(l)));
    expect(writers).toEqual(['44-laptop-failures.sh']);
  });

  // cli.ts:82-90 persists --bind/--port into the live config BEFORE any check.
  it.each(RUNNABLE)('%s passes --bind/--port to hub serve only from script 30', (f) => {
    for (const l of code(f)) {
      if (!/hub serve/.test(l)) continue;
      if (/--bind|--port/.test(l)) expect(f).toBe('30-hub-tokens-serve.sh');
    }
  });

  it.each(SCRIPTS)('%s removes nothing dangerous', (f) => {
    for (const [i, l] of code(f).entries()) {
      const m = l.match(/rm -rf\s+("?\$\{?\w+\}?"?|"?[^\s;|&]+"?)/);
      if (!m) continue;
      const target = m[1].replace(/"/g, '');
      expect(
        ['$HOME', '$HOME/.recall', '$HOME/.claude', '/mnt/c/Users/silve/.recall', '/', '$1', '$*'],
        `${f} line ${i + 1}`,
      ).not.toContain(target);
      // An unbraced variable at the path root is only allowed when it is quoted.
      if (/^\$\w+$/.test(target)) expect(m[1].startsWith('"'), `${f} line ${i + 1}`).toBe(true);
    }
  });

  it('60-hub-repair-full-snapshot.sh checks the bin symlink before its final rm -rf', () => {
    const l = lines('60-hub-repair-full-snapshot.sh');
    const guard = l.findIndex((x) => x.includes('[ -L "$S/bin" ]'));
    const lastRm = l.map((x, i) => (/rm -rf/.test(x) && !/^\s*#/.test(x) ? i : -1)).filter((i) => i >= 0).pop();
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(lastRm).toBeGreaterThan(guard);
  });

  it.each(STATE_CHANGING)('%s restores state from an EXIT trap', (f) => {
    expect(text(f)).toMatch(/trap .* EXIT/);
  });

  it.each(RUNNABLE)('%s calls only helpers that lib.sh defines', (f) => {
    const lib = text('lib.sh');
    const body = code(f).join('\n');
    for (const h of HELPERS) {
      const called = new RegExp(`(^|[\\s;(&|$\`"'])${h}(\\s|$|\\))`, 'm').test(body);
      if (!called) continue;
      expect(lib, `${f} calls ${h}`).toMatch(new RegExp(`^${h}\\s*\\(\\)`, 'm'));
    }
  });

  it('the README run order names exactly the runnable scripts', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    const named = new Set([...readme.matchAll(/`([0-9]{2}-[a-z0-9-]+\.sh)`/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(RUNNABLE);
  });
});
