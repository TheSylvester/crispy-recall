/**
 * statusline-cli — the wired command + `recall statusline` subcommand, end-to-end.
 *
 * Exercises the REAL built bundles from disk (the same code Claude Code runs),
 * not the pure renderers in isolation:
 *   - dist/statusline.js renders the standalone line and exits 0 (incl. bad JSON)
 *   - `recall statusline` prints the bare chip and never opens the DB / hangs
 *   - `recall statusline --suggest` prints guidance and never opens the DB
 *
 * Build-gated: skips cleanly when dist/ is absent (run `npm run build` first).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '..', '..');
const STATUSLINE_BUNDLE = join(ROOT, 'dist', 'statusline.js');
const RECALL_BUNDLE = join(ROOT, 'dist', 'recall.js');
const BUILT = existsSync(STATUSLINE_BUNDLE) && existsSync(RECALL_BUNDLE);
const suite = BUILT ? describe : describe.skip;

const JSON_IN = '{"session_id":"abc-123","cwd":"/x/y/proj","model":{"display_name":"Opus"}}';

/** Drop ANSI SGR codes — the wired standalone line is muted/colored. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let dir: string | undefined;
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

suite('statusline CLI / bundle (built)', () => {
  it('dist/statusline.js renders the STANDALONE line from stdin JSON and exits 0', () => {
    const r = spawnSync(process.execPath, [STATUSLINE_BUNDLE], { input: JSON_IN, encoding: 'utf-8', timeout: 15_000 });
    expect(r.status).toBe(0);
    const out = strip(r.stdout);
    expect(out).toContain('🔗 abc-123');
    expect(out).toContain('proj');   // proves renderStandaloneStatusline, not the bare chip
    expect(out).toContain('Opus');
  });

  it('dist/statusline.js renders the real git (branch*) via a live subprocess (workspace.current_dir)', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-sl-git-'));
    const git = (args: string[]) => spawnSync('git', args, { cwd: dir!, encoding: 'utf-8' });
    if (git(['init']).status !== 0) return; // git unavailable → skip cleanly
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['checkout', '-b', 'feat/live']);
    writeFileSync(join(dir, 'a.txt'), 'hi');
    git(['add', '.']);
    if (git(['commit', '-m', 'init']).status !== 0) return; // e.g. commit hooks env → skip
    // session JSON supplies workspace.current_dir (the precedence the git read uses).
    const payload = JSON.stringify({
      session_id: 'sid',
      workspace: { current_dir: dir },
      model: { display_name: 'Claude Opus 4.8' },
    });
    const run = () =>
      strip(spawnSync(process.execPath, [STATUSLINE_BUNDLE], { input: payload, encoding: 'utf-8', timeout: 15_000 }).stdout);

    const clean = run();
    expect(clean).toContain('(feat/live)'); // branch via the REAL spawnSync + parseGitStatus
    expect(clean).not.toContain('feat/live*'); // clean tree → no dirty marker

    writeFileSync(join(dir, 'a.txt'), 'changed'); // dirty the tree
    expect(run()).toContain('(feat/live*)'); // dirty marker via real `git status`
  });

  it('dist/statusline.js exits 0 and prints nothing on malformed JSON', () => {
    const r = spawnSync(process.execPath, [STATUSLINE_BUNDLE], { input: 'not json{{', encoding: 'utf-8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('`recall statusline` prints the bare CHIP from stdin and exits 0', () => {
    const r = spawnSync(process.execPath, [RECALL_BUNDLE, 'statusline'], { input: JSON_IN, encoding: 'utf-8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('🔗 abc-123'); // chip only — NOT the standalone line
  });

  it('`recall statusline` with closed stdin does NOT hang and exits 0', () => {
    const r = spawnSync(process.execPath, [RECALL_BUNDLE, 'statusline'], { input: '', encoding: 'utf-8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('`recall --blame statusline` reaches git-blame, NOT the statusline subcommand (dispatch ordering)', () => {
    // `--blame` is boolean, so `statusline` lands in positional[0]. The statusline
    // dispatch must run AFTER the commit/blame block or it hijacks the blame of a
    // file literally named `statusline`. Piping statusline JSON would print the
    // chip iff the subcommand wrongly fired; assert it never does — AND that the
    // blame path actually executed (a regression that swallows the subcommand
    // and exits silently must not pass).
    const r = spawnSync(process.execPath, [RECALL_BUNDLE, '--blame', 'statusline'], {
      input: '{"session_id":"HIJACK-X"}', encoding: 'utf-8', timeout: 15_000, cwd: ROOT,
    });
    expect(r.stdout).not.toContain('🔗');        // statusline subcommand did NOT fire
    expect(r.stdout).not.toContain('HIJACK-X');
    // Positive half: git-blame ran — a file named `statusline` doesn't exist in
    // the repo, so the blame path reports its no-such-file/no-matches outcome
    // rather than exiting with zero output.
    expect(r.stdout + r.stderr).not.toBe('');
  });

  it('`recall statusline <more words>` is a SEARCH, not the subcommand (query hijack guard)', () => {
    // The subcommand takes no positional args; a query whose first word happens
    // to be `statusline` must fall through to search instead of being silently
    // swallowed (exit 0, no output) on piped stdin.
    dir = mkdtempSync(join(tmpdir(), 'recall-sl-cli-'));
    const recallHome = join(dir, '.recall');
    // Stage dummy binary + model so the search's embed path doesn't attempt a
    // real download (ensureBinary auto-downloads when absent); the dummy spawn
    // fails fast and search degrades to FTS-only.
    mkdirSync(join(recallHome, 'bin'), { recursive: true });
    mkdirSync(join(recallHome, 'models'), { recursive: true });
    writeFileSync(join(recallHome, 'bin', 'llama-embedding'), 'dummy');
    writeFileSync(join(recallHome, 'models', 'nomic-embed-text-v1.5.Q8_0.gguf'), 'dummy');
    const r = spawnSync(process.execPath, [RECALL_BUNDLE, 'statusline', 'broken', 'yesterday'], {
      input: JSON_IN, encoding: 'utf-8', timeout: 20_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, '.claude'), RECALL_HOME: recallHome },
    });
    expect(r.stdout).not.toContain('🔗 abc-123'); // chip did NOT fire
    expect(r.stdout + r.stderr).not.toBe('');     // the search path produced output
  }, 30_000);

  it('dist/statusline.js stays LEAN (no db/embedder/paths imports, small on disk)', () => {
    // The wired command runs up to ~once/second under a <100ms budget. A bundle
    // that accidentally pulls in db/embedder would still render and keep every
    // behavioral test green — guard the leanness itself.
    expect(statSync(STATUSLINE_BUNDLE).size).toBeLessThan(20_480); // 20 KB ceiling (ships at ~2.5 KB)
    const src = readFileSync(STATUSLINE_BUNDLE, 'utf-8');
    for (const marker of ['better_sqlite3', 'better-sqlite3', 'llama', 'embed-config', 'node-fetch', 'EMBED_VERSION']) {
      expect(src).not.toContain(marker);
    }
  });

  it('`recall statusline --suggest` prints guidance, exits 0, and never opens the DB', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-sl-cli-'));
    const recallHome = join(dir, '.recall');
    const claudeDir = join(dir, '.claude'); // absent settings.json → the "none" guidance
    const r = spawnSync(process.execPath, [RECALL_BUNDLE, 'statusline', '--suggest'], {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, RECALL_HOME: recallHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('recall install --statusline'); // none-case guidance
    // The subcommand is dispatched before any DB init — no recall.db is created.
    const dbMade = existsSync(recallHome) && readdirSync(recallHome).includes('recall.db');
    expect(dbMade).toBe(false);
  });
});
