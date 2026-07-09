/**
 * statusline — the dedicated Claude Code statusLine command bundle.
 *
 * Emitted as dist/statusline.js and wired into ~/.claude/settings.json as
 *   "statusLine": { "type": "command", "command": "<node> <.recall/bin/statusline.js>" }
 * when (and only when) the user opts in AND has no existing status line.
 *
 * Claude Code pipes its status JSON to this command's stdin on each refresh and
 * renders stdout. This MUST be a LEAN bundle — it imports nothing beyond
 * node:process + node:child_process + the leaf renderer, so launching it costs
 * no db/embedder eval (the status line runs up to ~once/second under a <100ms
 * budget). NEVER wire `node recall.js statusline`: the full CLI statically
 * imports db/embedder.
 *
 * The one piece of IO this bundle does is a SINGLE, hard-time-boxed `git status`
 * (for the `(branch*)` segment). It is fully guarded: any failure, timeout, or
 * non-repo directory drops the git segment — it can never throw and never hang
 * the bar (400ms cap). All rendering lives in the pure leaf renderer.
 *
 * Discipline: read stdin fully, tolerate a bad/empty payload (empty object),
 * print the standalone line, and always exit 0.
 *
 * @module hooks/statusline
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  renderStandaloneStatusline,
  type StatuslineInput,
  type GitInfo,
} from '../recall/statusline-segment.js';

/**
 * Parse `git status --porcelain=v1 --branch` stdout into {branch, dirty}. Pure,
 * never throws. Returns undefined when there is no branch to show:
 *   `## main...origin/main [ahead 1]` → { main, dirty per following lines }
 *   `## main`                          → { main, ... }
 *   `## No commits yet on main`        → { main, ... }  (fresh repo, git ≥ 2.16)
 *   `## Initial commit on main`        → { main, ... }  (fresh repo, git < 2.16)
 *   `## HEAD (no branch)`              → undefined       (detached HEAD)
 * A `dirty` flag is any porcelain entry line (a line not starting with `## `).
 */
export function parseGitStatus(stdout: string): GitInfo | undefined {
  if (typeof stdout !== 'string' || stdout.length === 0) return undefined;
  const lines = stdout.split('\n');
  const header = lines.find((l) => l.startsWith('## '));
  if (!header) return undefined;
  const rest = header.slice(3);
  let branch: string | undefined;
  if (rest.startsWith('No commits yet on ')) {
    branch = rest.slice('No commits yet on '.length).trim();
  } else if (rest.startsWith('Initial commit on ')) {
    branch = rest.slice('Initial commit on '.length).trim(); // git < 2.16 wording
  } else if (rest.startsWith('HEAD (no branch)')) {
    branch = undefined; // detached HEAD — no branch name to show
  } else {
    // `main...origin/main [ahead 1]` → cut at the divergence / tracking markers.
    branch = rest.split(/\.\.\.| /, 1)[0]!.trim();
  }
  if (!branch) return undefined;
  const dirty = lines.some((l) => l.length > 0 && !l.startsWith('## '));
  return { branch, dirty };
}

/**
 * Time-boxed, fully-guarded git read. Any failure / timeout / non-repo →
 * undefined (the dir segment simply drops git). Single subprocess with a hard
 * 400ms cap so a huge or slow repo can never hang the ~1/sec bar.
 */
function readGit(cwd: string): GitInfo | undefined {
  try {
    const res = spawnSync('git', ['status', '--porcelain=v1', '--branch'], {
      cwd,
      timeout: 400,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return undefined;
    return parseGitStatus(res.stdout);
  } catch {
    return undefined;
  }
}

async function runStatusline(): Promise<void> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  let json: StatuslineInput;
  try {
    json = JSON.parse(data) as StatuslineInput;
  } catch {
    json = {};
  }
  const cwd = json?.workspace?.current_dir ?? json?.cwd;
  const git = typeof cwd === 'string' && cwd.length > 0 ? readGit(cwd) : undefined;
  process.stdout.write(renderStandaloneStatusline(json ?? {}, { git }));
  process.exit(0);
}

// Only consume stdin / exit when invoked as the statusline entry point. When the
// module is imported (unit tests), the IIFE must NOT run — otherwise it blocks
// on stdin and calls process.exit. In the esbuild CJS bundle
// `require.main === module` is true only for the direct `node statusline.js`.
declare const require: NodeJS.Require | undefined;
declare const module: NodeJS.Module | undefined;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runStatusline();
}
