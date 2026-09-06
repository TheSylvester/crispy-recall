/**
 * `recall` CLI project scoping (spec §4.4) — BUILT-BUNDLE tests.
 *
 * Proves the precedence rule end to end: `--project-key` wins and suppresses
 * derivation entirely, a bare `--project` derives, and `--all` drops the scope.
 * A fake `git` first on the CHILD's PATH records every spawn, so "no
 * derivation" is a measured fact, not an inference.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

import { _setTestRoot, binDir, dbPath, modelsDir } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { normalizePath } from '../../src/url-path-resolver.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');
const HOOK_BUNDLE = join(ROOT, 'dist', 'stop-hook.js');

const TERM = 'wolverine';
const PAD = ' padded out well beyond the fifty character minimum embedding floor.';

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let repoDir: string;
let repoKey: string;
let fakeGitDir: string;
let gitLog: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf8' }).trim();
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeGitDir}:${process.env['PATH'] ?? ''}`,
    RECALL_HOME: recallHome,
    RECALL_REMOTE_ROOT: join(recallHome, 'remote'),
    CLAUDE_CONFIG_DIR: join(recallHome, 'claude'),
    CODEX_HOME: join(recallHome, 'codex'),
    RECALL_LOG_LEVEL: 'error',
  };
}

interface RunResult { status: number | null; stdout: string; stderr: string }

function runCli(args: string[], opts?: { cwd?: string; realGit?: boolean }): RunResult {
  // `realGit` hands the child the REAL PATH: the cases that must actually
  // derive a key need the real executable, not the recording stub.
  const env = opts?.realGit
    ? { ...childEnv(), PATH: process.env['PATH'] ?? '' }
    : childEnv();
  const r = spawnSync(process.execPath, [CLI_BUNDLE, ...args, '--no-catchup'], {
    env, cwd: opts?.cwd ?? recallHome, encoding: 'utf-8', timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gitSpawns(): number {
  if (!existsSync(gitLog)) return 0;
  return readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).length;
}

/** Minimal fake llama-embedding: no network, no real model, records nothing we need. */
function stageFakeBackend(): void {
  mkdirSync(binDir(), { recursive: true });
  mkdirSync(modelsDir(), { recursive: true });
  const embedBin = join(binDir(), 'llama-embedding');
  writeFileSync(embedBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
function argOf(f){const i=args.indexOf(f);return i>=0?args[i+1]:undefined;}
const fs = require('fs');
const sep = argOf('--embd-separator') || '<#sep#>';
let joined = argOf('-p'); if (joined === undefined) { const f = argOf('-f'); joined = f ? fs.readFileSync(f,'utf8') : ''; }
const texts = joined.split(sep);
process.stdout.write(JSON.stringify(texts.map(() => Array.from({length:768},(_,i)=>(i%7)/7-0.5))));
`);
  chmodSync(embedBin, 0o755);
  const serverBin = join(binDir(), 'llama-server');
  writeFileSync(serverBin, '#!/usr/bin/env node\nprocess.exit(1);\n');
  chmodSync(serverBin, 0o755);
  const model = join(modelsDir(), 'nomic-embed-text-v1.5.Q8_0.gguf');
  const fd = openSync(model, 'w'); closeSync(fd);
  truncateSync(model, 150_000_000);
}

function seed(): void {
  const d = getDb(dbPath());
  const rows: Array<[string, string, string, string | null]> = [
    // S1 lives in the real repo and carries its git key.
    ['S1', 'S1-m0', normalizePath(repoDir), repoKey],
    // S2 is a DIFFERENT path with the SAME repo key (another clone/worktree).
    ['S2', 'S2-m0', '/x/two', repoKey],
    // S3 is unrelated and unkeyed.
    ['S3', 'S3-m0', '/x/three', null],
  ];
  let t = 1000;
  for (const [sid, mid, projectId, key] of rows) {
    d.run(
      `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role, retrieval_class, project_key)
       VALUES (?, ?, 0, ?, ?, ?, 'assistant', 'hot', ?)`,
      [mid, sid, `${TERM} narration for ${sid}${PAD}`, projectId, t++, key],
    );
  }
  _resetDb();
}

beforeAll(() => {
  if (!existsSync(CLI_BUNDLE)) throw new Error('dist/recall.js missing — run `npm run build` first');
  recallHome = join(tmpdir(), `recall-pkey-cli-${randomUUID()}`);
  mkdirSync(join(recallHome, 'claude'), { recursive: true });
  mkdirSync(join(recallHome, 'codex'), { recursive: true });
  restoreRoot = _setTestRoot(recallHome);

  // A REAL repo (real git, parent PATH untouched) — this is the ground truth key.
  repoDir = join(recallHome, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repoDir, 'a.txt'), 'a\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'first']);
  repoKey = 'git:' + git(repoDir, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]!.trim();

  // The fake git the CHILDREN see: records every spawn, then defers to nothing.
  fakeGitDir = join(recallHome, 'fakegit');
  mkdirSync(fakeGitDir, { recursive: true });
  gitLog = join(recallHome, 'git-spawns.log');
  const script = join(fakeGitDir, 'git');
  writeFileSync(script, `#!/bin/sh\necho "$*" >> "${gitLog}"\nexit 128\n`, { mode: 0o755 });
  chmodSync(script, 0o755);

  stageFakeBackend();
  _resetDb();
  seed();
});

afterAll(() => {
  restoreRoot?.(); restoreRoot = undefined;
  _resetDb();
  if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(gitLog, { force: true });
});

describe.skipIf(platform() === 'win32')('recall CLI project scoping', () => {
  it('--project-key wins and spawns NO git at all', () => {
    const r = runCli(['--project-key', repoKey, '--project', repoDir, TERM, '--raw']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('S1');
    expect(r.stdout).toContain('S2');
    expect(r.stdout).not.toContain('S3');
    expect(gitSpawns()).toBe(0);
  });

  it('--project scopes by path when the target is not a repo (step 0, no spawn)', () => {
    // /x/two does not exist, so derivation short-circuits at step 0 to a
    // path: key — git is never reached.
    const r = runCli(['--project', '/x/two', TERM, '--raw']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('S2');
    expect(r.stdout).not.toContain('S1');
    expect(r.stdout).not.toContain('S3');
    expect(gitSpawns()).toBe(0);
  });

  it('--project <repo> derives git:<root> and returns every session of that repo', () => {
    const r = runCli(['--project', repoDir, TERM, '--raw'], { realGit: true });
    expect(r.status, r.stderr).toBe(0);
    // S1 matches on the path half, S2 on the key half — one repo, two cwds.
    expect(r.stdout).toContain('S1');
    expect(r.stdout).toContain('S2');
    expect(r.stdout).not.toContain('S3');
  });

  it('no --project at all: the cwd is derived the same way (precedence 4)', () => {
    const r = runCli([TERM, '--raw'], { cwd: repoDir, realGit: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('S1');
    expect(r.stdout).toContain('S2');
    expect(r.stdout).not.toContain('S3');
  });

  it('--all drops the scope entirely and never derives', () => {
    const r = runCli(['--all', TERM, '--raw']);
    expect(r.status, r.stderr).toBe(0);
    for (const sid of ['S1', 'S2', 'S3']) expect(r.stdout).toContain(sid);
    expect(gitSpawns()).toBe(0);
  });

  it('--version and --help never derive (no git spawn at module scope)', () => {
    expect(runCli(['--version']).status).toBe(0);
    expect(runCli(['--help']).status).toBe(0);
    expect(gitSpawns()).toBe(0);
  });

  // A bare directory is NOT a project key: it matched no row, so the query
  // silently fell back to cwd-only scoping. Reject the shape at parse time.
  it.each(['/not/a/key', 'repoKey', 'git:deadbeef'])(
    'rejects a --project-key that is not a project key: %s', (bad) => {
      const r = runCli(['--project-key', bad, TERM, '--raw']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--project-key expects git:<hex>, origin:<url> or path:<dir>');
      expect(r.stdout).not.toContain('S1');
      expect(gitSpawns()).toBe(0);
    });

  it('a path: key is still accepted and scopes as before', () => {
    const r = runCli(['--project-key', 'path:/x/two', '--project', '/x/two', TERM, '--raw']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('S2');
    expect(r.stdout).not.toContain('S3');
    expect(gitSpawns()).toBe(0);
  });

  it('the Stop hook stamps git:<root> derived once from payload.cwd', async () => {
    const sid = randomUUID();
    const transcript = join(repoDir, `${sid}.jsonl`);
    const entries = [
      { type: 'user', uuid: `${sid}-m0`, parentUuid: null, sessionId: sid,
        timestamp: '2026-05-01T10:00:00.000Z',
        message: { role: 'user', content: `hookstamp fixture prompt${PAD}` } },
      { type: 'assistant', uuid: `${sid}-m1`, parentUuid: `${sid}-m0`, sessionId: sid,
        timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'assistant', content: `hookstamp fixture reply${PAD}` } },
    ];
    writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // The hook must see the REAL git — it is the machine that owns the repo.
    const env = { ...childEnv(), PATH: process.env['PATH'] ?? '' };
    const child = spawnSync(process.execPath, [HOOK_BUNDLE], {
      env, encoding: 'utf-8', timeout: 60_000,
      input: JSON.stringify({
        hook_event_name: 'Stop', session_id: sid, transcript_path: transcript, cwd: repoDir,
      }),
    });
    expect(child.status, child.stderr).toBe(0);

    _resetDb();
    const rows = getDb(dbPath()).all(
      'SELECT DISTINCT project_id, project_key FROM messages WHERE session_id = ?', [sid],
    ) as Array<{ project_id: string; project_key: string }>;
    expect(rows).toEqual([{ project_id: normalizePath(repoDir), project_key: repoKey }]);
    _resetDb();
  });
});
