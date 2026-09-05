/**
 * Project key derivation (spec §4.1) — the fixture matrix from §9.1.2.
 *
 * Every case builds a REAL git repository in a temp directory, because the
 * contract is about what git actually answers (shallow boundaries, unborn
 * HEAD, replace refs, several root commits), not about a parser.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  clearProjectKeyCache, deriveProjectKey, foldKeyPath, normalizeOrigin, resolveCaseInsensitive,
  upgradeLocalPathKey, wslUncToPosix,
} from '../../src/recall/project-key.js';
import { normalizePath } from '../../src/url-path-resolver.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { searchMessagesFts } from '../../src/recall/message-store.js';

const FIXED_DATE = '2026-01-02T03:04:05+00:00';

let sandbox: string;
let prevPath: string | undefined;
let prevRemote: string | undefined;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always',
    ...args,
  ], { cwd, encoding: 'utf8', env: env ?? process.env }).trim();
}

/** A repo with `n` commits, all dated `date`. Returns its path. */
function makeRepo(name: string, n = 2, date = FIXED_DATE): string {
  const repo = join(sandbox, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repo, `f${i}.txt`), `content ${i}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `c${i}`], {
      ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    });
  }
  return repo;
}

function rootCommit(repo: string): string {
  return git(repo, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]!.trim();
}

/**
 * Put a shell script named `git` first on PATH. `body` is the script body; it
 * receives the real argv, so it can answer per subcommand.
 */
function fakeGit(body: string): string {
  const dir = mkdtempSync(join(sandbox, 'fakegit-'));
  const script = join(dir, 'git');
  writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
  return dir;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-pkey-'));
  prevPath = process.env['PATH'];
  prevRemote = process.env['RECALL_REMOTE_ROOT'];
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, 'remote');
  clearProjectKeyCache();
});

afterEach(() => {
  if (prevPath === undefined) delete process.env['PATH']; else process.env['PATH'] = prevPath;
  if (prevRemote === undefined) delete process.env['RECALL_REMOTE_ROOT'];
  else process.env['RECALL_REMOTE_ROOT'] = prevRemote;
  clearProjectKeyCache();
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('deriveProjectKey — repository fixtures', () => {
  it('a normal repo keys on its root commit', () => {
    const repo = makeRepo('normal', 3);
    const r = deriveProjectKey(repo);
    expect(r.kind).toBe('git');
    expect(r.key).toBe('git:' + rootCommit(repo));
    expect(r.toplevel).toBeTruthy();
  });

  it('a linked worktree and a subdirectory key the SAME as the repo', () => {
    const repo = makeRepo('wt-main', 3);
    const expected = 'git:' + rootCommit(repo);

    const wt = join(sandbox, 'wt-linked');
    git(repo, ['worktree', 'add', '-q', '-b', 'side', wt]);
    expect(deriveProjectKey(wt).key).toBe(expected);

    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(deriveProjectKey(sub).key).toBe(expected);
  });

  it('a shallow clone with an https origin keys on the normalized origin', () => {
    const origin = makeRepo('origin-src', 3);
    const clone = join(sandbox, 'shallow-https');
    git(sandbox, ['clone', '-q', '--depth', '1', `file://${origin}`, clone]);
    git(clone, ['remote', 'set-url', 'origin', 'https://github.com/x/y.git']);

    const r = deriveProjectKey(clone);
    expect(r.kind).toBe('origin');
    expect(r.key).toBe('origin:github.com/x/y');
  });

  it('a shallow clone whose only origin is file:// falls back to a path key', () => {
    const origin = makeRepo('origin-file', 3);
    const clone = join(sandbox, 'shallow-file');
    git(sandbox, ['clone', '-q', '--depth', '1', `file://${origin}`, clone]);

    const r = deriveProjectKey(clone);
    expect(r.kind).toBe('path');
    expect(r.key).toBe('path:' + foldKeyPath(normalizePath(clone)));
  });

  it('an unborn HEAD (git init, no commits, no origin) keys on the toplevel path', () => {
    const repo = join(sandbox, 'unborn');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);

    const r = deriveProjectKey(repo);
    expect(r.kind).toBe('path');
    expect(r.key).toBe('path:' + foldKeyPath(normalizePath(r.toplevel!)));
  });

  it('several root commits sort by (%ct asc, hash asc) — the tie breaks on the hash', () => {
    // Two unrelated histories with the SAME commit time, merged, so ONLY the
    // hash tie-break can decide. `checkout --orphan` is confined to this
    // throwaway fixture repo.
    const repo = makeRepo('multi-root', 1);
    const first = rootCommit(repo);
    git(repo, ['checkout', '-q', '--orphan', 'other']);
    git(repo, ['rm', '-q', '-rf', '.']);
    writeFileSync(join(repo, 'other.txt'), 'other root\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'other root'], {
      ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE,
    });
    const second = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '-q', '--allow-unrelated-histories', '--no-edit', '-m', 'merge', 'other'], {
      ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE,
    });

    const roots = git(repo, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').map((x) => x.trim());
    expect(roots.sort()).toEqual([first, second].sort());
    const smaller = [first, second].sort()[0]!;
    expect(deriveProjectKey(repo).key).toBe('git:' + smaller);
  });

  it('a replace-ref graft does not move the key off the TRUE root', () => {
    const repo = makeRepo('graft', 3);
    const trueRoot = rootCommit(repo);
    git(repo, ['replace', '--graft', 'HEAD']); // HEAD now looks parentless
    expect(deriveProjectKey(repo).key).toBe('git:' + trueRoot);
  });

  it('a non-git directory keys on its own path', () => {
    const dir = join(sandbox, 'plain');
    mkdirSync(dir, { recursive: true });
    const r = deriveProjectKey(dir);
    expect(r.kind).toBe('path');
    expect(r.key).toBe('path:' + foldKeyPath(normalizePath(dir)));
    expect(r.toplevel).toBeUndefined();
  });

  it('a MISSING directory keys on its path without spawning git at all', () => {
    const marker = join(sandbox, 'spawned.txt');
    fakeGit(`echo ran >> "${marker}"\nexit 0`);
    const gone = join(sandbox, 'not-there', 'deep');

    const r = deriveProjectKey(gone);
    expect(r.kind).toBe('path');
    expect(r.key).toBe('path:' + foldKeyPath(normalizePath(gone)));
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(platform() === 'win32')('deriveProjectKey — transient failures', () => {
  it('rev-list that times out then dies on a signal returns transient, never a key', () => {
    const state = join(sandbox, 'rev-list-calls');
    fakeGit(`
case "$*" in
  *rev-parse*) echo false; echo "$PWD"; exit 0;;
  *rev-list*)
    n=0; [ -f "${state}" ] && n=$(cat "${state}")
    n=$((n+1)); echo $n > "${state}"
    if [ "$n" = "1" ]; then sleep 30; exit 0; fi
    kill -TERM $$; sleep 30; exit 0;;
esac
exit 1`);
    const dir = join(sandbox, 'transient-revlist');
    mkdirSync(dir, { recursive: true });

    const r = deriveProjectKey(dir);
    expect(r.key).toBeUndefined();
    expect(r.transientFailure).toBe(true);
    expect(r.kind).toBe('transient');
    expect(readFileSync(state, 'utf8').trim()).toBe('2'); // one retry, no more
  }, 30_000);

  it('rev-parse that fails transiently gives the SAME transient result', () => {
    const state = join(sandbox, 'rev-parse-calls');
    fakeGit(`
case "$*" in
  *rev-parse*)
    n=0; [ -f "${state}" ] && n=$(cat "${state}")
    n=$((n+1)); echo $n > "${state}"
    if [ "$n" = "1" ]; then sleep 30; exit 0; fi
    kill -TERM $$; sleep 30; exit 0;;
esac
exit 1`);
    const dir = join(sandbox, 'transient-revparse');
    mkdirSync(dir, { recursive: true });

    const r = deriveProjectKey(dir);
    expect(r.key).toBeUndefined();
    expect(r.transientFailure).toBe(true);
    expect(readFileSync(state, 'utf8').trim()).toBe('2');
  }, 30_000);

  it('a shallow repo whose `config` dies twice is transient, never a path key', () => {
    const state = join(sandbox, 'config-calls');
    fakeGit(`
case "$*" in
  *rev-parse*) echo true; echo "$PWD"; exit 0;;
  *config*)
    n=0; [ -f "${state}" ] && n=$(cat "${state}")
    n=$((n+1)); echo $n > "${state}"
    kill -TERM $$; sleep 30; exit 0;;
esac
exit 1`);
    const dir = join(sandbox, 'transient-config');
    mkdirSync(dir, { recursive: true });

    const r = deriveProjectKey(dir);
    expect(r.key).toBeUndefined();
    expect(r.transientFailure).toBe(true);
    expect(r.kind).toBe('transient');
    expect(readFileSync(state, 'utf8').trim()).toBe('2'); // one retry, no more
  }, 30_000);

  it('a spawn error other than ENOENT (EACCES) is transient, not a path key', () => {
    // A `git` that exists but cannot be executed → EACCES. PATH holds ONLY
    // this directory, so execvp has nowhere else to look and the error stands.
    const dir = mkdtempSync(join(sandbox, 'fakegit-noexec-'));
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    chmodSync(join(dir, 'git'), 0o644);
    process.env['PATH'] = dir;

    const target = join(sandbox, 'eacces-target');
    mkdirSync(target, { recursive: true });
    const r = deriveProjectKey(target);
    expect(r.key).toBeUndefined();
    expect(r.transientFailure).toBe(true);
  });

  it('a transient result is NOT cached — the next caller retries', () => {
    const state = join(sandbox, 'retry-calls');
    fakeGit(`
n=0; [ -f "${state}" ] && n=$(cat "${state}")
n=$((n+1)); echo $n > "${state}"
case "$*" in
  *rev-parse*) kill -TERM $$; sleep 30; exit 0;;
esac
exit 1`);
    const dir = join(sandbox, 'transient-uncached');
    mkdirSync(dir, { recursive: true });

    expect(deriveProjectKey(dir).transientFailure).toBe(true);
    const after1 = Number(readFileSync(state, 'utf8').trim());
    expect(deriveProjectKey(dir).transientFailure).toBe(true);
    expect(Number(readFileSync(state, 'utf8').trim())).toBeGreaterThan(after1);
  }, 30_000);
});

describe.skipIf(platform() === 'win32')('deriveProjectKey — memoization', () => {
  it('two calls spawn one set of git processes; clearProjectKeyCache re-spawns', () => {
    const log = join(sandbox, 'git-calls.log');
    fakeGit(`
echo "$1" >> "${log}"
case "$*" in
  *rev-parse*) echo false; echo "$PWD"; exit 0;;
esac
exit 128`);
    const dir = join(sandbox, 'memo');
    mkdirSync(dir, { recursive: true });

    const first = deriveProjectKey(dir);
    expect(first.key).toBe('path:' + foldKeyPath(normalizePath(dir)));
    const afterFirst = readFileSync(log, 'utf8').trim().split('\n').length;

    expect(deriveProjectKey(dir)).toBe(first); // same object → cache hit
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBe(afterFirst);

    clearProjectKeyCache();
    deriveProjectKey(dir);
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeGreaterThan(afterFirst);
  });
});

describe('normalizeOrigin', () => {
  const table: Array<[string, string | undefined]> = [
    ['https://github.com/x/y.git', 'github.com/x/y'],
    ['https://github.com/x/y', 'github.com/x/y'],
    ['https://github.com/x/y/', 'github.com/x/y'],
    ['https://GitHub.COM/TheSylvester/Crispy-Recall.git', 'github.com/thesylvester/crispy-recall'],
    ['https://user:pass@github.com/x/y.git', 'github.com/x/y'],
    // An `@` in the PATH is not a credential — only the authority is stripped.
    ['https://git.example.com/team/proj@v2/repo.git', 'git.example.com/team/proj@v2/repo'],
    ['https://github.com:443/x/y.git', 'github.com/x/y'],
    ['ssh://git@github.com/x/y.git', 'github.com/x/y'],
    ['ssh://git@github.com:2222/x/y.git', 'github.com/x/y'],
    ['git://github.com/x/y.git', 'github.com/x/y'],
    ['git+ssh://git@github.com/x/y.git', 'github.com/x/y'],
    ['git@github.com:TheSylvester/crispy-recall.git', 'github.com/thesylvester/crispy-recall'],
    ['file:///home/u/dev/repo.git', undefined],
    ['/home/u/dev/repo.git', undefined],
    ['../sibling-repo', undefined],
    ['C:\\winDev\\repo', undefined],
    ['', undefined],
    ['   ', undefined],
  ];
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeOrigin(input)).toBe(expected);
    });
  }
});

describe('foldKeyPath', () => {
  it('lowercases a win32 path that is not POSIX-absolute', () => {
    expect(foldKeyPath('C:/WinDev/Proj', 'win32')).toBe('c:/windev/proj');
    expect(foldKeyPath('//Server/Share/Dev', 'win32')).toBe('//server/share/dev');
  });

  it('keeps the case of a POSIX-absolute path on win32 too', () => {
    // A Windows satellite working on a WSL repository derives the POSIX path
    // the Linux hub owns. POSIX paths are case-sensitive, so folding here
    // would split the one repository across two keys again.
    expect(foldKeyPath('/home/u/Dev/Proj', 'win32')).toBe('/home/u/Dev/Proj');
    expect(foldKeyPath('/home/u/Dev/Proj', 'linux')).toBe('/home/u/Dev/Proj');
  });

  it('folds a Windows-SHAPED path on any host, and leaves a POSIX path alone', () => {
    // The hub re-keys Windows satellite project_ids on Linux; both sides must
    // land on the same key.
    expect(foldKeyPath('C:/WinDev/Proj', 'linux')).toBe('c:/windev/proj');
    expect(foldKeyPath('/home/u/Dev/Proj', 'linux')).toBe('/home/u/Dev/Proj');
  });
});

describe.skipIf(platform() === 'win32')('non-ASCII cwd round-trip', () => {
  it('a 日本語 repo path derives, ingests and is found by a scoped search', async () => {
    const recallHome = join(sandbox, '.recall');
    mkdirSync(recallHome, { recursive: true });
    const restore = _setTestRoot(recallHome);
    _resetDb();
    try {
      const parent = join(sandbox, '日本語');
      mkdirSync(parent, { recursive: true });
      const repo = makeRepo(join('日本語', 'proj'), 2);
      const key = deriveProjectKey(repo).key!;
      expect(key).toBe('git:' + rootCommit(repo));

      getDb(dbPath());
      const sid = randomUUID();
      const jsonl = join(sandbox, `${sid}.jsonl`);
      const entries = [
        { type: 'user', uuid: `${sid}-u1`, sessionId: sid, cwd: repo,
          timestamp: '2026-05-01T10:00:00.000Z',
          message: { role: 'user', content: 'kanjipathfixture please index this unicode project directory' } },
        { type: 'assistant', uuid: `${sid}-a1`, sessionId: sid, cwd: repo,
          timestamp: '2026-05-01T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'kanjipathfixture indexed the unicode project directory' }] } },
      ];
      writeFileSync(jsonl, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const res = await ingestSessionMessages(sid, jsonl, 'claude');
      expect(res.error).toBeUndefined();

      const stored = getDb(dbPath()).all(
        'SELECT DISTINCT project_id, project_key FROM messages WHERE session_id = ?', [sid],
      ) as Array<{ project_id: string; project_key: string }>;
      expect(stored).toEqual([{ project_id: normalizePath(repo), project_key: key }]);

      const hits = searchMessagesFts('kanjipathfixture', 20, normalizePath(repo), undefined, undefined, undefined, key);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.session_id === sid)).toBe(true);
    } finally {
      restore();
      _resetDb();
    }
  });
});

describe('wslUncToPosix', () => {
  it('converts every accepted UNC spelling', () => {
    expect(wslUncToPosix('\\\\wsl$\\Ubuntu\\home\\silver\\dev\\x'))
      .toEqual({ distro: 'Ubuntu', posix: '/home/silver/dev/x' });
    expect(wslUncToPosix('\\\\wsl.localhost\\Ubuntu\\home\\x'))
      .toEqual({ distro: 'Ubuntu', posix: '/home/x' });
    expect(wslUncToPosix('//wsl$/Ubuntu/home/x'))
      .toEqual({ distro: 'Ubuntu', posix: '/home/x' });
    // The host part is matched in any case; the POSIX half keeps its own.
    expect(wslUncToPosix('\\\\WSL$\\Ubuntu-22.04\\home\\Silver\\Dev'))
      .toEqual({ distro: 'Ubuntu-22.04', posix: '/home/Silver/Dev' });
    // The distro root alone is still the POSIX root.
    expect(wslUncToPosix('\\\\wsl$\\Ubuntu')).toEqual({ distro: 'Ubuntu', posix: '/' });
  });

  it('collapses separator runs and accepts the extended-length prefixes', () => {
    expect(wslUncToPosix('\\\\wsl$\\Ubuntu\\home\\\\silver'))
      .toEqual({ distro: 'Ubuntu', posix: '/home/silver' });
    expect(wslUncToPosix('//wsl$//Ubuntu/home/x'))
      .toEqual({ distro: 'Ubuntu', posix: '/home/x' });
    expect(wslUncToPosix('\\\\?\\UNC\\wsl$\\Ubuntu\\home\\x'))
      .toEqual({ distro: 'Ubuntu', posix: '/home/x' });
  });

  it('leaves every other shape alone', () => {
    expect(wslUncToPosix('C:\\Users\\u\\dev')).toBeUndefined();
    expect(wslUncToPosix('c:/Users/u/dev')).toBeUndefined();
    expect(wslUncToPosix('/home/silver/dev/x')).toBeUndefined();
    expect(wslUncToPosix('\\\\Server\\Share\\dev')).toBeUndefined();
    expect(wslUncToPosix('')).toBeUndefined();
  });
});

describe.skipIf(platform() === 'win32')('a \\\\wsl$ UNC cwd', () => {
  it('keys by the POSIX path when git cannot answer', () => {
    // The hub has no such directory, and a Windows satellite with no git on
    // PATH answers the same way. Both must land on the POSIX path key.
    const r = deriveProjectKey('\\\\wsl$\\Ubuntu\\home\\silver\\dev\\antidote-dev');
    expect(r.kind).toBe('path');
    expect(r.key).toBe('path:/home/silver/dev/antidote-dev');
  });

  it('keys the same way through every accepted UNC spelling', () => {
    // On the hub the UNC cwd itself never exists, so derivation takes the
    // vanished-directory branch. Every spelling must still land on one key.
    const expected = 'path:/home/silver/dev/antidote-dev';
    for (const cwd of [
      '\\\\wsl.localhost\\Ubuntu\\home\\silver\\dev\\antidote-dev',
      '//wsl$/Ubuntu/home/silver/dev/antidote-dev',
      '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\silver\\dev\\antidote-dev',
    ]) {
      clearProjectKeyCache();
      expect(deriveProjectKey(cwd).key).toBe(expected);
    }
  });

  it('upgradeLocalPathKey turns a local POSIX path key into the repo key', () => {
    const repo = makeRepo('unc-repo', 2);
    const key = 'path:' + repo;
    expect(upgradeLocalPathKey(key)).toBe('git:' + rootCommit(repo));
    // A path this machine does not own, and a key that is already a repo
    // identity, are both returned unchanged.
    expect(upgradeLocalPathKey('path:/no/such/dir/anywhere')).toBe('path:/no/such/dir/anywhere');
    expect(upgradeLocalPathKey('path:c:/windev/proj')).toBe('path:c:/windev/proj');
    expect(upgradeLocalPathKey('git:' + 'a'.repeat(40))).toBe('git:' + 'a'.repeat(40));
  });
});

describe.skipIf(platform() === 'win32')('resolveCaseInsensitive', () => {
  let prevHome: string | undefined;
  beforeEach(() => { prevHome = process.env['HOME']; process.env['HOME'] = sandbox; });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
  });

  it('finds a directory whose case the old win32 fold destroyed', () => {
    const real = join(sandbox, 'Dev', 'Claro');
    mkdirSync(real, { recursive: true });
    expect(resolveCaseInsensitive(real)).toBe(real);
    expect(resolveCaseInsensitive(join(sandbox, 'dev', 'claro'))).toBe(real);
  });

  it('gives up on an absent path, on ambiguity, and outside the home tree', () => {
    mkdirSync(join(sandbox, 'Dev', 'Claro'), { recursive: true });
    expect(resolveCaseInsensitive(join(sandbox, 'dev', 'nope'))).toBeUndefined();
    // Two entries that differ only in case: guessing could key the wrong repo.
    mkdirSync(join(sandbox, 'Dev', 'CLARO'), { recursive: true });
    expect(resolveCaseInsensitive(join(sandbox, 'dev', 'claro'))).toBeUndefined();
    expect(resolveCaseInsensitive('/etc/PASSWD-not-here')).toBeUndefined();
  });
});

describe.skipIf(platform() === 'win32')('upgradeLocalPathKey', () => {
  let prevHome: string | undefined;
  beforeEach(() => { prevHome = process.env['HOME']; process.env['HOME'] = sandbox; });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
  });

  it('upgrades a UNC key and a case-folded key alike', () => {
    const repo = makeRepo('Claro', 2);
    const expected = 'git:' + rootCommit(repo);
    expect(upgradeLocalPathKey('path:' + repo)).toBe(expected);
    // An old sidecar still carries the UNC spelling; `repair --full` re-reads
    // those, so it must not undo a completed rekey.
    clearProjectKeyCache();
    expect(upgradeLocalPathKey('path://wsl$/ubuntu' + repo.toLowerCase())).toBe(expected);
  });

  it('memoizes the NEGATIVE answer so one sweep spawns git once', () => {
    const dir = join(sandbox, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    const marker = join(sandbox, 'git-calls');
    fakeGit(`echo ran >> "${marker}"\nexit 128`);

    expect(upgradeLocalPathKey('path:' + dir)).toBe('path:' + dir);
    const after = readFileSync(marker, 'utf-8');
    expect(upgradeLocalPathKey('path:' + dir)).toBe('path:' + dir);
    expect(readFileSync(marker, 'utf-8')).toBe(after);

    // Clearing the cache lets the next sweep retry.
    clearProjectKeyCache();
    expect(upgradeLocalPathKey('path:' + dir)).toBe('path:' + dir);
    expect(readFileSync(marker, 'utf-8').length).toBeGreaterThan(after.length);
  });
});
