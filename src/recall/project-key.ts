/**
 * Project key — repo-derived project identity (spec §4.1, decision D7).
 *
 * `project_id` is a cwd string, so one repository looks like many projects:
 * a worktree, a clone, a subdirectory and the same path on another machine
 * all scope apart. The KEY is derived from the repository instead — its root
 * commit, else its origin URL, else its toplevel path — so those cases unify.
 * The key is stored BESIDE `project_id`, never instead of it, and the filter
 * matches either half (`project_key = ? OR project_id = ?`).
 *
 * Behaviour changes this introduces (spec §4.5):
 *
 * - A default (scoped) search now returns every worktree, clone and
 *   subdirectory session of the same repository. Forks that share a root
 *   commit merge; that is accepted.
 * - A repository keyed `git:` on one machine and `origin:` on another (a
 *   shallow clone, or a repo that gained or lost its origin) does not unify
 *   until both sides agree. `repair --rekey-projects` fills NULL keys only,
 *   unless `--force` is given.
 * - On Windows, non-git directories unify across casings through the key half
 *   only: the key is fully folded, while `project_id` keeps normalizePath's
 *   drive-letter-only rule. A POSIX-absolute path is exempt from the fold.
 * - A Windows satellite that works on a WSL repository sees a `\\wsl$\…` UNC
 *   cwd. That cwd keys by the POSIX path inside the distro, and the hub
 *   upgrades such a key to the repository identity it can see itself
 *   (`upgradeLocalPathKey`), so one repository keeps one key.
 *
 * @module recall/project-key
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { normalizePath } from '../url-path-resolver.js';

/** The outcome of one derivation. `key` is undefined ONLY on transient failure. */
export interface ProjectKeyResult {
  /** `git:<40 hex>` | `origin:<value>` | `path:<folded normalized path>`. */
  key: string | undefined;
  kind: 'git' | 'origin' | 'path' | 'transient';
  /** Repository toplevel, when `git rev-parse` answered. */
  toplevel?: string;
  /** Set when the `git` executable itself is absent (ENOENT). */
  gitMissing?: true;
  /** Set when git timed out or died on a signal twice — the caller stores NULL. */
  transientFailure?: true;
}

/** Memoized per normalized cwd. Negative results are cached; transient are not. */
const cache = new Map<string, ProjectKeyResult>();

/** Drop every memoized derivation (long-lived processes: the hub sweep). */
export function clearProjectKeyCache(): void {
  cache.clear();
}

const GIT_TIMEOUT_MS = 3000;

function runGit(cwd: string, args: string[], timeout?: number): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(timeout === undefined ? {} : { timeout }),
    windowsHide: true,
  });
}

/**
 * A failure git may recover from on a retry: the spawn itself failed for any
 * reason other than "there is no git here" (ETIMEDOUT from the 3 s timeout,
 * EAGAIN/EMFILE/ENOMEM under load, EACCES on a transient mount), or the child
 * died on a signal. spawnSync reports a timeout as `status: null`,
 * `signal: 'SIGTERM'`, `error.code: 'ETIMEDOUT'`.
 *
 * ENOENT is NOT transient: it means the executable is absent, which the
 * gitMissing branches answer with a path key.
 */
function isTransient(r: SpawnSyncReturns<string>): boolean {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && code !== 'ENOENT') return true;
  return r.signal != null;
}

/**
 * Lowercase the WHOLE path for a Windows key. Applied to the KEY only — never
 * to `project_id`, which keeps normalizePath's drive-letter-only rule.
 *
 * The fold triggers on the HOST or on the SHAPE of the path. Shape matters
 * because `repair --rekey-projects` runs on the Linux hub over `project_id`
 * values a Windows satellite wrote (`c:/WinDev/Proj`): without the shape test
 * the hub would key `path:c:/WinDev/Proj` while the satellite keys
 * `path:c:/windev/proj`, and the two would never unify.
 *
 * A POSIX-ABSOLUTE path is exempt on every host, win32 included: a Windows
 * satellite that works on a WSL repository derives `/home/u/Dev/Proj`, and
 * the Linux hub that owns that directory keys the same string with its case
 * intact. Folding it on the satellite alone would split the repository again.
 */
export function foldKeyPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z]:\//.test(p)) return p.toLowerCase();
  if (/^\/(?!\/)/.test(p)) return p;
  return platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * A `\\wsl$\<distro>\<path>` or `\\wsl.localhost\<distro>\<path>` UNC path
 * split into its distro and the POSIX path INSIDE that distro. Both
 * separator styles and any case of the host part are accepted; the POSIX
 * half keeps its case, because POSIX paths are case-sensitive.
 *
 * Returns undefined for every other shape — a drive path, a plain POSIX
 * path, and any other UNC share.
 */
export function wslUncToPosix(p: string): { distro: string; posix: string } | undefined {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(p.trim());
  if (!m) return undefined;
  const rest = (m[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return { distro: m[1]!, posix: '/' + rest };
}

/**
 * The `path:` key for a directory.
 *
 * A `\\wsl$\…` cwd is rewritten to the POSIX path first: the Windows
 * satellite sees the repository through a mount, while the hub owns the
 * directory itself. Both must key the one repository the same way.
 */
function pathKey(p: string): string {
  const unc = wslUncToPosix(p);
  if (unc) return 'path:' + unc.posix;
  return 'path:' + foldKeyPath(normalizePath(p));
}

/**
 * Upgrade a `path:` key that names a directory THIS machine owns.
 *
 * The hub receives `path:/home/u/dev/x` from a Windows satellite that reached
 * the repository through `\\wsl$\Ubuntu\home\u\dev\x`. The satellite could
 * not see the repository identity across that mount; the hub can. Keys that
 * name no local directory, and keys that already carry a repo identity, are
 * returned unchanged.
 */
export function upgradeLocalPathKey(key: string): string {
  if (!key.startsWith('path:')) return key;
  const p = key.slice('path:'.length);
  // POSIX-absolute only: a drive path or a UNC share on the hub is not ours.
  if (!/^\/(?!\/)/.test(p)) return key;
  if (!existsSync(p)) return key;
  const r = deriveProjectKey(p);
  if (r.key && (r.kind === 'git' || r.kind === 'origin')) return r.key;
  return key;
}

/**
 * Normalize a remote URL to `host/path`, lowercased, with no scheme,
 * credentials, port, `.git` suffix or trailing slash.
 *
 * Returns undefined for anything without a host — `file://` URLs, bare
 * filesystem paths and Windows paths — because those identify a location on
 * one machine, not a repository shared between machines.
 */
export function normalizeOrigin(url: string): string | undefined {
  let s = url.trim();
  if (!s) return undefined;
  if (/^file:\/\//i.test(s)) return undefined;
  if (/^[A-Za-z]:/.test(s)) return undefined;

  // scheme://
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(s);
  if (scheme) {
    s = s.slice(scheme[0].length);
  } else if (s.includes('://')) {
    return undefined;
  }

  // user:pass@host — inside the AUTHORITY only. An `@` further along is part
  // of the path (`/team/proj@v2/repo.git`) and must survive.
  const firstSlash = s.indexOf('/');
  const authEnd = firstSlash < 0 ? s.length : firstSlash;
  const at = s.lastIndexOf('@', authEnd - 1);
  if (at >= 0) s = s.slice(at + 1);

  if (!scheme) {
    // scp-like `host:path` → `host/path`. A leading `/` or `./` is a bare path.
    if (s.startsWith('/') || s.startsWith('.')) return undefined;
    const colon = s.indexOf(':');
    if (colon < 0) return undefined;
    s = s.slice(0, colon) + '/' + s.slice(colon + 1).replace(/^\/+/, '');
  }

  // host[:port]/path
  const slash = s.indexOf('/');
  let host = slash < 0 ? s : s.slice(0, slash);
  const rest = slash < 0 ? '' : s.slice(slash);
  const port = /^(.*):(\d+)$/.exec(host);
  if (port) host = port[1]!;
  if (!host) return undefined;

  s = host + rest;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  if (!s.includes('/')) return undefined;
  return s.toLowerCase();
}

/** The transient sentinel — never cached, never carries a key. */
function transient(): ProjectKeyResult {
  return { key: undefined, kind: 'transient', transientFailure: true };
}

/**
 * Derive the project key for a working directory.
 *
 * Never throws: every git failure resolves to a `path:` key, except a genuine
 * transient failure, which returns `key: undefined` so the caller stores NULL
 * and falls back to path-only scoping. A transient failure MUST NEVER emit a
 * different key class — a wrong key would silently split a project's history.
 */
export function deriveProjectKey(cwd: string): ProjectKeyResult {
  const cacheKey = normalizePath(cwd);
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const result = derive(cwd);
  // Transient results are NOT cached: the next caller retries.
  if (!result.transientFailure) cache.set(cacheKey, result);
  return result;
}

function derive(cwd: string): ProjectKeyResult {
  // 0. A vanished directory (a deleted worktree, a satellite path on the hub)
  //    still scopes by its path — spawning git in a missing cwd only throws.
  if (!existsSync(cwd)) return { kind: 'path', key: pathKey(cwd) };

  // 1. Is this a repository, is it shallow, and where is its toplevel?
  //    An unborn repo answers `false` + toplevel with exit 0.
  let rev = runGit(cwd, ['rev-parse', '--is-shallow-repository', '--show-toplevel'], GIT_TIMEOUT_MS);
  if ((rev.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return { kind: 'path', key: pathKey(cwd), gitMissing: true };
  }
  if (isTransient(rev)) {
    rev = runGit(cwd, ['rev-parse', '--is-shallow-repository', '--show-toplevel']);
    if ((rev.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { kind: 'path', key: pathKey(cwd), gitMissing: true };
    }
    if (isTransient(rev)) return transient();
  }
  if (rev.status === 128) return { kind: 'path', key: pathKey(cwd) };
  if (rev.status !== 0) return { kind: 'path', key: pathKey(cwd) };

  const lines = (rev.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const shallow = lines[0] === 'true';
  const toplevel = lines[1];

  // 2. A shallow clone reports the graft boundary, not the true root commit —
  //    skip to origin. Doctor warns and names `git fetch --unshallow`.
  if (!shallow) {
    // 3. Root commit. `--no-replace-objects` so a `git replace --graft` cannot
    //    rewrite history under us.
    const args = ['--no-replace-objects', 'rev-list', '--max-parents=0', '--format=%ct %H', 'HEAD'];
    let roots = runGit(cwd, args, GIT_TIMEOUT_MS);
    if (isTransient(roots)) {
      roots = runGit(cwd, args);
      if (isTransient(roots)) return transient();
    }
    if (roots.status === 0) {
      // Unrelated-history merges give several roots; order by (%ct asc, hash
      // asc) so every machine picks the same one.
      const parsed: Array<{ ct: number; hash: string }> = [];
      for (const line of (roots.stdout ?? '').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('commit ')) continue;
        const m = /^(\d+)\s+([0-9a-f]{40})$/.exec(t);
        if (m) parsed.push({ ct: Number(m[1]), hash: m[2]! });
      }
      parsed.sort((a, b) => (a.ct - b.ct) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      const first = parsed[0];
      if (first) {
        return { kind: 'git', key: 'git:' + first.hash, ...(toplevel ? { toplevel } : {}) };
      }
    }
    // Deterministic failure (unborn HEAD, status 128) or no root parsed → step 4.
  }

  // 4. Origin URL — the only identity a shallow clone can share with its peers.
  //    Same transient rule as steps 1 and 3: a git that never answered must
  //    not silently downgrade the repo to a path key.
  let origin = runGit(cwd, ['config', '--get', 'remote.origin.url'], GIT_TIMEOUT_MS);
  if (isTransient(origin)) {
    origin = runGit(cwd, ['config', '--get', 'remote.origin.url']);
    if (isTransient(origin)) return transient();
  }
  if (origin.status === 0) {
    const value = normalizeOrigin(origin.stdout ?? '');
    if (value) return { kind: 'origin', key: 'origin:' + value, ...(toplevel ? { toplevel } : {}) };
  }

  // 5. Path of the repository toplevel — non-git directories stay scoped as today.
  return { kind: 'path', key: pathKey(toplevel ?? cwd), ...(toplevel ? { toplevel } : {}) };
}
