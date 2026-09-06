/**
 * Static lint of the spec §9 acceptance scripts under `contrib/satellite/e2e/`.
 *
 * The scripts drive the owner's REAL machines, so this suite never executes a
 * live script body: it checks syntax/text and runs selected command-building
 * blocks with mocked tools. Helper tests SOURCE lib.sh, which runs `mkdir -p`.
 * Those calls pass both RECALL_E2E_LOG_DIR and HOME on a temp dir,
 * so it cannot reach the owner's live ~/.recall even if one of the two is ever
 * dropped — lib.sh reads no other filesystem root.
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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  'rows', 'hub_sql_file', 'scan_list', 'in_list', 'require_e2e_env',
];

/**
 * Machine-specific literals from the owner's own boxes. None may survive in a
 * line of code; a comment may still show one as an example.
 */
const PERSONAL =
  /100\.79\.117|100\.64\.125|\/home\/silver|\/home\/sylvester|Users\/silve|silverera2|sylvester-laptop|v22\.18\.0/;

/** Every environment variable name the kit reads, so README.md can be checked. */
const ENV_NAME = /RECALL_E2E_[A-Z0-9_]+|RECALL_(?:MAIN_CHECKOUT|INT_WORKTREE|BASE_WORKTREE|NODE|PARITY_[A-Z]+|TOKEN_FILE)/g;

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

  // `set -u` must be in force before ANY body runs: it may be preceded only by
  // the shebang, comments, blank lines and the `source lib.sh` line, and it must
  // come before the first heredoc. A length limit would only measure how long a
  // script's DEVIATION header is.
  it.each(SCRIPTS)('%s sets -u before any body', (f) => {
    const l = lines(f);
    const setU = l.findIndex((x) => /^set -u$/.test(x));
    expect(setU).toBeGreaterThanOrEqual(0);
    const preamble = /^\s*(#|$)|^#!|^source "\$\(dirname "\$0"\)\/lib\.sh"$/;
    const firstBody = l.findIndex((x) => !preamble.test(x));
    expect(setU, `${f}: first body line is ${firstBody + 1} (${l[firstBody]})`).toBe(firstBody);
    const firstHeredoc = l.findIndex((x) => /<<-?'?[A-Za-z_]+'?/.test(x));
    if (firstHeredoc >= 0) expect(setU).toBeLessThan(firstHeredoc);
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

  // Every `pass` call names $NAME first, so the single printed PASS line always
  // starts `PASS <script>` — a suffix like " (synthetic hook: …)" is allowed.
  // (A script may hold more than one exit path; 61 has an early --run-less one.)
  it.each(NEEDS_LIB)('%s passes on $NAME, optional suffix', (f) => {
    const calls = [...text(f).matchAll(/(?:^|[\s;&|])pass "([^"]*)"/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) expect(c).toMatch(/^\$NAME/);
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
        [
          '$HOME', '$HOME/.recall', '$HOME/.claude',
          '$WIN_HOME', '$WIN_HOME/.recall', '$WIN_HOME/.claude',
          '/mnt/c/Users/silve/.recall', '/', '$1', '$*',
        ],
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

  // An INSTALLING trap: `trap - EXIT` (which clears one) must not satisfy this.
  it.each(STATE_CHANGING)('%s restores state from an EXIT trap', (f) => {
    expect(text(f)).toMatch(/trap\s+[^-\s][^\n]*\bEXIT\b/);
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

  // The acceptance seat is a Claude Code session; the native binary refuses a
  // nested `claude -p` while CLAUDECODE is set. lib.sh must clear it for every
  // script that sources it. RECALL_E2E_LOG_DIR points at a temp dir so sourcing
  // lib.sh cannot mkdir under the owner's live ~/.recall.
  it('lib.sh unsets CLAUDECODE', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-lint-'));
    const out = execFileSync(
      'bash',
      ['-c', `. "${join(DIR, 'lib.sh')}"; printf '[%s]' "\${CLAUDECODE-unset}"`],
      { env: { ...process.env, CLAUDECODE: '1', RECALL_E2E_LOG_DIR: tmp, HOME: tmp }, encoding: 'utf8' },
    );
    expect(out).toBe('[unset]');
    rmSync(tmp, { recursive: true, force: true });
  });

  // Nobody but the owner can run a script that hard-codes the owner's machines.
  // Comments may keep an example; a line of code may not.
  it.each(SCRIPTS)('%s carries no personal literal in code', (f) => {
    const hits = code(f).filter((l) => PERSONAL.test(l));
    expect(hits.join('\n')).toBe('');
  });

  // A variable a script reads but the README never names is undiscoverable.
  it('README.md documents every environment variable the scripts read', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    const used = new Set<string>();
    for (const f of SCRIPTS) for (const m of text(f).matchAll(ENV_NAME)) used.add(m[0]);
    const undocumented = [...used].sort().filter((n) => !readme.includes(n));
    expect(undocumented).toEqual([]);
  });

  // lib.sh must survive an almost-empty environment: it is sourced by scripts
  // that have not yet been told which machines to drive, and by this suite.
  // Every machine-specific default is therefore empty and gated lazily by
  // require_e2e_env, and every derived value uses `${VAR:-}` under `set -u`.
  it('lib.sh sources cleanly with an empty environment', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-lint-'));
    const res = spawnSync('bash', ['-c', `. "${join(DIR, 'lib.sh')}"`], {
      env: { HOME: tmp, RECALL_E2E_LOG_DIR: tmp, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the README run order names exactly the runnable scripts', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    const named = new Set([...readme.matchAll(/`([0-9]{2}-[a-z0-9-]+\.sh)`/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(RUNNABLE);
  });
});

// Execute only isolated helpers / the install selection block, with fake tools.
// No SSH, WSL interop, npm install, or acceptance script body can reach a host.
describe('E2E candidate and Windows command regressions', () => {
  it.each([false, true])('selects the installed candidate with nvm on PATH (stale=%s)', (stale) => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-candidate-'));
    try {
      const nvm = join(tmp, 'nvm bin');
      mkdirSync(nvm);
      writeFileSync(join(nvm, 'recall'), '#!/bin/bash\necho old-nvm-release\n', { mode: 0o755 });
      // Fake npm installs a fake CLI into precisely the requested --prefix.
      writeFileSync(join(nvm, 'npm'), `#!/bin/bash
[ "$1 $2 $3" = 'install -g --prefix' ] || exit 9
mkdir -p "$4/bin"
printf '#!/bin/bash\\necho ${stale ? 'wrong-version' : '0.4.0-candidate'}\\n' > "$4/bin/recall"
chmod +x "$4/bin/recall"
`, { mode: 0o755 });
      const script = text('40-laptop-install.sh');
      const block = script.slice(script.indexOf('INST=$(lap '), script.indexOf('step "installing in satellite mode'));
      const result = spawnSync('bash', ['-c', `
source "$1/lib.sh"
NAME=test
EXPECTED_VERSION=0.4.0-candidate
lap() { bash -c "$1"; }
${block}
` , '_', DIR], {
        env: { PATH: '/usr/bin:/bin', HOME: tmp, RECALL_E2E_LOG_DIR: tmp,
          RECALL_E2E_LAPTOP_HOME: tmp, RECALL_E2E_LAPTOP_PATH_PREFIX: nvm }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(stale ? 1 : 0);
      expect(result.stdout).toContain(join(tmp, '.local/bin/recall'));
      if (stale) expect(result.stderr).toContain('does not match tarball');
      else expect(result.stderr).toBe('');
      // Subsequent acceptance commands also resolve the new candidate.
      if (!stale) {
        const out = execFileSync('bash', ['-c', 'source "$1/lib.sh"; eval "export PATH=\\\"$LAPTOP_PATH_PREFIX:$PATH\\\""; recall', '_', DIR], {
          env: { PATH: '/usr/bin:/bin', HOME: tmp, RECALL_E2E_LOG_DIR: tmp,
            RECALL_E2E_LAPTOP_HOME: tmp, RECALL_E2E_LAPTOP_PATH_PREFIX: nvm }, encoding: 'utf8',
        });
        expect(out.trim()).toBe('0.4.0-candidate');
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('rejects an old nvm binary override before remote installation', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-override-'));
    try {
      const script = text('40-laptop-install.sh');
      const guard = script.slice(script.indexOf('[ "${RECALL_E2E_LAPTOP_RECALL_BIN'), script.indexOf('EXPECTED_VERSION='));
      const result = spawnSync('bash', ['-c', `source "$1/lib.sh"; NAME=test; ${guard}`, '_', DIR], {
        env: { PATH: '/usr/bin:/bin', HOME: tmp, RECALL_E2E_LOG_DIR: tmp,
          RECALL_E2E_LAPTOP_HOME: tmp, RECALL_E2E_LAPTOP_RECALL_BIN: `${tmp}/nvm/recall` }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the candidate install');
      expect(script.indexOf('RECALL_E2E_LAPTOP_RECALL_BIN')).toBeLessThan(script.indexOf('OLD=$(lap'));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('reads the expected version from tarball metadata, not the filename', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-version-'));
    try {
      mkdirSync(join(tmp, 'package'));
      writeFileSync(join(tmp, 'package/package.json'), JSON.stringify({ version: '0.4.0-candidate' }));
      const tgz = join(tmp, 'misleading-name.tgz');
      execFileSync('tar', ['czf', tgz, '-C', tmp, 'package']);
      const script = text('40-laptop-install.sh');
      const block = script.slice(script.indexOf('EXPECTED_VERSION='), script.indexOf('mask()'));
      const out = execFileSync('bash', ['-c', `TGZ=$1; ${block}\nprintf '%s' "$EXPECTED_VERSION"`, '_', tgz], { encoding: 'utf8' });
      expect(out).toBe('0.4.0-candidate');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('runs relative batch names from a spaced Windows profile directory and preserves failure', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-win-'));
    try {
      const dir = join(tmp, 'Alex Smith', 'Temp');
      const out = spawnSync('bash', ['-c', `
source "$1/lib.sh"
WIN_DIR=$2
# Replace the entire process-launch boundary: no cmd.exe is executed.
timeout() { printf 'cwd=%s\\n' "$PWD"; printf 'arg=<%s>\\n' "$@"; return 7; }
win_cmd sample <<'CMD'
@echo off
exit /b %ERRORLEVEL%
CMD
`, '_', DIR, dir], {
        env: { PATH: '/usr/bin:/bin', HOME: tmp, RECALL_E2E_LOG_DIR: tmp, RECALL_E2E_WIN_USER: 'Alex Smith' }, encoding: 'utf8',
      });
      expect(out.status).toBe(7);
      expect(out.stdout).toBe(`cwd=${dir}\narg=<300>\narg=<cmd.exe>\narg=</c>\narg=<sample.cmd>\n`);
      expect(readFileSync(join(dir, 'sample.cmd'), 'utf8')).toBe('@echo off\r\nexit /b %ERRORLEVEL%\r\n');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('constructs the Windows install batch with quoted spaced operands', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-win-batch-'));
    try {
      const script = text('50-win-install.sh');
      const start = script.indexOf('win_cmd 50-install <<CMD');
      const block = script.slice(start, script.indexOf('\nCMD', start) + 4);
      const out = execFileSync('bash', ['-c', `source "$1/lib.sh"; win_cmd() { cat; }; ${block}`, '_', DIR], {
        env: { PATH: '/usr/bin:/bin', HOME: tmp, RECALL_E2E_LOG_DIR: tmp,
          RECALL_E2E_WIN_USER: 'Alex Smith', RECALL_E2E_HUB_ADDR: 'example.invalid' }, encoding: 'utf8',
      });
      const profile = 'C:\\Users\\Alex Smith';
      expect(out).toContain(`install -g "${profile}\\AppData\\Local\\Temp\\recall-e2e\\crispy-recall.tgz"`);
      expect(out).toContain(`RECALL_HUB_TOKEN=<"${profile}\\AppData\\Local\\Temp\\recall-e2e\\token.txt"`);
      expect(out).toContain(`call "${profile}\\AppData\\Roaming\\npm\\recall.cmd" install`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it.each(WINDOWS_SCRIPTS)('%s quotes derived Windows batch paths', (f) => {
    const bodies = [...text(f).matchAll(/<<'?CMD'?\n([\s\S]*?)\nCMD\b/g)].map((m) => m[1]);
    for (const body of bodies) {
      expect(body).not.toMatch(/call \$WIN_(?:RECALL|CLAUDE)_W/);
      expect(body).not.toMatch(/(?:-g |<)\$WIN_DIR_W/);
    }
  });
});
