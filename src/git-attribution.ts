/**
 * Git Attribution — match git commits to the Claude Code session(s) that
 * produced their edits.
 *
 * Given a commit hash (or a list of file paths), scan local Claude Code
 * `.jsonl` transcripts and return the sessions whose Edit/Write/MultiEdit
 * tool calls structurally match the commit's diff. Pure on-demand
 * computation — no persistent index, no cache beyond a per-invocation
 * memoization of `git show <hash>:<file>`.
 *
 * Algorithm (per commit):
 *   1. Inspect the commit (files, parent time, author time, added lines).
 *   2. mtime-prefilter session jsonls to a small candidate set whose
 *      modification time overlaps the search window.
 *   3. Stream-parse each candidate, keep edits in `[parent, commit+1h]`.
 *   4. Require ≥1 in-window edit to a commit-touched file.
 *   5. Build tri-grams of session edits and of the commit's added lines;
 *      intersection > 0 → match.
 *   6. Compute `surviving_ratio` against the commit's file state (deduped
 *      per file to avoid double-counting tri-grams shared across files).
 *
 * Subagent transcripts at `<project>/<parent-uuid>/subagents/agent-*.jsonl`
 * are scanned alongside top-level files. A subagent match is attributed to
 * its leaf `agent-<hash>` ID; the directory's parent UUID is exposed as
 * `parent_session_id` so callers can follow the dispatch chain.
 *
 * Scope: pure function. Inputs are a repo path + a commit hash or file
 * paths; output is a chronologically sorted `SessionMatch[]`. Shells out to
 * `git`; reads from `~/.claude/projects/<slug>/`. No DB writes, no recall
 * index dependency.
 *
 * Boundary: this module does NOT format CLI output, does NOT promote
 * matches into recall, and does NOT decide which match is "best". Callers
 * reason from the full chronological list.
 *
 * @module git-attribution
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  extractSessionEdits,
  type SessionEdit,
  type SessionEditTrace,
} from './adapters/claude/transcript-edits.js';
import { log } from './log.js';

// ============================================================================
// Types
// ============================================================================

export interface CommitInfo {
  hash: string;
  /** Commit author time, epoch ms. */
  commitTime: number;
  /** Parent commit author time, epoch ms. 0 for root commits. */
  parentTime: number;
  /** Files changed in the commit (repo-relative paths). */
  files: string[];
  /** Per-file added lines from the diff. */
  addedLines: Map<string, string[]>;
  /** Per-file removed lines from the diff. */
  removedLines: Map<string, string[]>;
}

export interface SessionMatch {
  /** Top-level session UUID, or `agent-<hash>` for subagent leaves. */
  session: string;
  /** Parent session UUID when `session` is a subagent leaf; null otherwise. */
  parent_session_id: string | null;
  /** Subagent type (e.g. "Explore") when known; null otherwise. */
  agent_type: string | null;
  /** Full commit hash. */
  commit: string;
  /** Commit-touched files this session edited in window. */
  matched_files: string[];
  /** Tri-gram intersections between session edits and commit's added lines. */
  content_hits: number;
  /** Number of session edits inside the search window. */
  edit_count: number;
  /** ISO timestamp of the latest in-window edit. */
  last_edit_at: string;
  /** `surviving_ratio >= 0.5`. Boolean compatibility signal. */
  surviving_in_commit: boolean;
  /** Fraction of session tri-grams still present in the commit's file state. */
  surviving_ratio: number;
}

export interface AttributionOptions {
  /**
   * Absolute path to the repo root (the cwd Claude was started in).
   * Used to locate the Claude project directory and to strip leading
   * components when matching session edit paths to git diff paths.
   */
  repoRoot: string;
  /**
   * Override the sessions directory. Defaults to
   * `~/.claude/projects/<slug(repoRoot)>`.
   */
  sessionsDir?: string;
  /**
   * Window padding after commit time, in milliseconds. Edits with timestamps
   * up to `commitTime + windowAfterMs` are considered. Default: 1 hour.
   */
  windowAfterMs?: number;
}

export interface BlameSpec {
  /** Repo-relative file path. */
  path: string;
  /** Optional starting line (1-based, inclusive). */
  lineStart?: number;
  /** Optional ending line (1-based, inclusive). Defaults to `lineStart`. */
  lineEnd?: number;
}

export interface BlameAttributionOptions extends AttributionOptions {
  /** Cap the number of returned matches (after sorting). */
  limit?: number;
}

/**
 * Parse a blame spec of the form `<path>`, `<path>:<line>`, or
 * `<path>:<L1>-<L2>`. The path may contain `:` characters; the suffix is
 * only treated as a line/range if it's numeric.
 */
export function parseBlameSpec(s: string): BlameSpec {
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return { path: s };
  const tail = s.slice(lastColon + 1);
  const m = tail.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return { path: s };
  const lineStart = parseInt(m[1]!, 10);
  const lineEnd = m[2] !== undefined ? parseInt(m[2], 10) : lineStart;
  return { path: s.slice(0, lastColon), lineStart, lineEnd };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Find the sessions that produced a single commit.
 *
 * Returned matches are sorted chronologically ascending by `last_edit_at`.
 * The most recent is usually the load-bearing edit, but the full list is
 * preserved because earlier matches reveal evolution / superseded work.
 */
export async function findSessionsForCommit(
  commitHash: string,
  opts: AttributionOptions,
): Promise<SessionMatch[]> {
  const info = getCommitInfo(opts.repoRoot, commitHash);
  return matchCommit(info, opts, new Map());
}

/**
 * Find the sessions that produced the commits responsible for the given
 * file or line range, via `git blame`.
 *
 * - No line range: blame the whole file. Returns sessions for every commit
 *   whose lines still appear in HEAD (deduped).
 * - With a line / range: `git blame -L <start>,<end>` narrows to commits
 *   that authored those specific lines.
 *
 * Multiple specs are unioned (each spec's blame commits are merged into
 * one set, then attributed). Results are merged across commits and sorted
 * chronologically.
 *
 * Note: this is intentionally HEAD-relative — it surfaces sessions whose
 * work *survives* in the current code, not every historical iteration. For
 * the full historical walk, use `git log -- <path>` upstream and call
 * `findSessionsForCommit` per commit.
 */
export async function findSessionsForBlame(
  specs: BlameSpec[],
  opts: BlameAttributionOptions,
): Promise<SessionMatch[]> {
  if (specs.length === 0) return [];

  const commitSet = new Set<string>();
  for (const spec of specs) {
    for (const h of blameCommits(opts.repoRoot, spec)) {
      commitSet.add(h);
    }
  }

  // Reuse per-commit-file `git show` results across iterations.
  const commitFileTriCache = new Map<string, Set<string>>();

  const all: SessionMatch[] = [];
  for (const h of commitSet) {
    let info: CommitInfo;
    try {
      info = getCommitInfo(opts.repoRoot, h);
    } catch (err) {
      log({
        source: 'git-attribution',
        level: 'warn',
        summary: `failed to read commit ${h}`,
        data: { error: String(err) },
      });
      continue;
    }
    const ms = await matchCommit(info, opts, commitFileTriCache);
    for (const m of ms) all.push(m);
  }

  all.sort((a, b) => Date.parse(a.last_edit_at) - Date.parse(b.last_edit_at));
  if (opts.limit && opts.limit > 0 && all.length > opts.limit) {
    return all.slice(-opts.limit);
  }
  return all;
}

/**
 * Inspect a commit and return its files, timestamps, and per-file diff.
 *
 * Exposed for callers that want raw commit context (e.g. to render diffs)
 * without re-running git.
 */
export function getCommitInfo(repoRoot: string, hash: string): CommitInfo {
  const meta = git(repoRoot, ['show', '--pretty=format:%H%n%aI', '--name-only', hash]).trim().split('\n');
  const fullHash = meta[0] ?? hash;
  const commitTime = meta[1] ? Date.parse(meta[1]) : 0;
  const files = meta.slice(2).filter((f) => f.length > 0);

  const parentRaw = gitSafe(repoRoot, ['log', '-1', '--pretty=format:%aI', `${hash}^`]);
  const parentTime = parentRaw ? Date.parse(parentRaw.trim()) : 0;

  const diff = git(repoRoot, ['show', '-U0', hash]);
  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  let curFile: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      curFile = null;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      curFile = line.slice(6);
      if (!added.has(curFile)) added.set(curFile, []);
      if (!removed.has(curFile)) removed.set(curFile, []);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@')) continue;
    if (!curFile) continue;
    if (line.startsWith('+')) added.get(curFile)!.push(line.slice(1));
    else if (line.startsWith('-')) removed.get(curFile)!.push(line.slice(1));
  }

  return { hash: fullHash, commitTime, parentTime, files, addedLines: added, removedLines: removed };
}

// ============================================================================
// Sessions-dir resolution
// ============================================================================

/** Claude Code's project-slug encoding of a cwd (all non-alphanumerics → '-'). */
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Crispy's historical narrower encoding — kept as a fallback probe. */
function cwdToProjectSlugNarrow(cwd: string): string {
  return cwd.replace(/[:\/\\]/g, '-');
}

function defaultSessionsDir(repoRoot: string): string {
  const claudeRoot = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
  const broad = path.join(claudeRoot, 'projects', cwdToProjectSlug(repoRoot));
  if (fs.existsSync(broad)) return broad;
  const narrow = path.join(claudeRoot, 'projects', cwdToProjectSlugNarrow(repoRoot));
  if (fs.existsSync(narrow)) return narrow;
  return broad; // missing-dir warn path uses the canonical form
}

// ============================================================================
// Matching internals
// ============================================================================

interface CandidateFile {
  jsonlPath: string;
  parentSessionId: string | null;
  agentType: string | null;
}

async function matchCommit(
  info: CommitInfo,
  opts: AttributionOptions,
  commitFileTriCache: Map<string, Set<string>>,
): Promise<SessionMatch[]> {
  const commitFiles = new Set(info.files);
  const windowAfterMs = opts.windowAfterMs ?? 60 * 60 * 1000;
  const lower = info.parentTime;
  const upper = info.commitTime + windowAfterMs;

  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir(opts.repoRoot);

  if (!fs.existsSync(sessionsDir)) {
    log({
      source: 'git-attribution',
      level: 'warn',
      summary: `sessions dir not found: ${sessionsDir}`,
    });
    return [];
  }

  const candidates = collectCandidates(sessionsDir, lower, info.commitTime);

  const addedTriByFile = new Map<string, Set<string>>();
  for (const [file, lines] of info.addedLines) {
    addedTriByFile.set(file, triGrams(lines));
  }

  const matches: SessionMatch[] = [];
  for (const cand of candidates) {
    let trace: SessionEditTrace;
    try {
      trace = await extractSessionEdits(cand.jsonlPath, { repoRoot: opts.repoRoot });
    } catch (err) {
      log({
        source: 'git-attribution',
        level: 'debug',
        summary: `extractSessionEdits failed for ${cand.jsonlPath}`,
        data: { error: String(err) },
      });
      continue;
    }
    if (trace.skippedLines > 0 || trace.skippedEvents > 0) {
      log({
        source: 'git-attribution',
        level: 'debug',
        summary: `skipped content in ${cand.jsonlPath}`,
        data: { skippedLines: trace.skippedLines, skippedEvents: trace.skippedEvents },
      });
    }
    if (trace.edits.length === 0) continue;

    const inWindow = trace.edits.filter((e) => e.ts >= lower && e.ts <= upper);
    if (inWindow.length === 0) continue;

    const touchedFiles = new Set(inWindow.map((e) => e.file).filter((f) => commitFiles.has(f)));
    if (touchedFiles.size === 0) continue;

    // Per-file tri-gram sets for session edits to commit-touched files.
    // Per-file dedup avoids double-counting tri-grams that appear in
    // multiple files (the bug noted in the spike's caveats).
    const sessionTriByFile = new Map<string, Set<string>>();
    for (const e of inWindow) {
      if (!commitFiles.has(e.file)) continue;
      let bucket = sessionTriByFile.get(e.file);
      if (!bucket) {
        bucket = new Set<string>();
        sessionTriByFile.set(e.file, bucket);
      }
      for (const t of triGrams(e.content.split('\n'))) bucket.add(t);
    }
    if (sessionTriByFile.size === 0) continue;

    let contentHits = 0;
    for (const [file, sessTri] of sessionTriByFile) {
      const add = addedTriByFile.get(file);
      if (!add) continue;
      for (const t of sessTri) {
        if (add.has(t)) contentHits++;
      }
    }
    if (contentHits === 0) continue;

    // Surviving ratio: per file, what fraction of this session's tri-grams
    // for the file survive in the commit's file state. Aggregate is the
    // size-weighted average across files. Numerator and denominator are
    // both summed per file → cannot exceed 1.0.
    let survivingHits = 0;
    let totalTris = 0;
    for (const [file, sessTri] of sessionTriByFile) {
      const commitTri = lookupCommitFileTri(opts.repoRoot, info.hash, file, commitFileTriCache);
      totalTris += sessTri.size;
      for (const t of sessTri) {
        if (commitTri.has(t)) survivingHits++;
      }
    }
    const ratio = totalTris === 0 ? 0 : survivingHits / totalTris;

    const lastEditTs = inWindow.reduce((m, e) => (e.ts > m ? e.ts : m), -Infinity);
    matches.push({
      session: trace.sessionId,
      parent_session_id: cand.parentSessionId,
      agent_type: cand.agentType,
      commit: info.hash,
      matched_files: [...touchedFiles],
      content_hits: contentHits,
      edit_count: inWindow.length,
      last_edit_at: new Date(lastEditTs).toISOString(),
      surviving_in_commit: ratio >= 0.5,
      surviving_ratio: Math.round(ratio * 100) / 100,
    });
  }

  matches.sort((a, b) => Date.parse(a.last_edit_at) - Date.parse(b.last_edit_at));
  return matches;
}

/**
 * Walk `sessionsDir` and its `<parent>/subagents/` subdirs, returning files
 * whose mtime overlaps the search window. The mtime filter is a coarse but
 * effective prefilter — reduces 1000s of jsonls to ~10s of candidates per
 * commit.
 */
function collectCandidates(
  sessionsDir: string,
  lower: number,
  commitTime: number,
): CandidateFile[] {
  const mtimeLower = lower - 60_000;
  const mtimeUpper = commitTime + 24 * 60 * 60 * 1000;

  const inWindow = (p: string): boolean => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      return false;
    }
    if (stat.mtimeMs < mtimeLower) return false;
    if (stat.mtimeMs > mtimeUpper) return false;
    return true;
  };

  const out: CandidateFile[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      const full = path.join(sessionsDir, ent.name);
      if (inWindow(full)) {
        out.push({ jsonlPath: full, parentSessionId: null, agentType: null });
      }
      continue;
    }
    if (!ent.isDirectory()) continue;
    const parentDir = path.join(sessionsDir, ent.name);
    const subDir = path.join(parentDir, 'subagents');
    let subEntries: string[];
    try {
      subEntries = fs.readdirSync(subDir);
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      if (!sub.endsWith('.jsonl')) continue;
      const full = path.join(subDir, sub);
      if (!inWindow(full)) continue;
      const metaPath = path.join(subDir, sub.slice(0, -'.jsonl'.length) + '.meta.json');
      let agentType: string | null = null;
      try {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(raw) as { agentType?: unknown };
        if (typeof meta.agentType === 'string') agentType = meta.agentType;
      } catch {
        // meta.json is optional
      }
      out.push({ jsonlPath: full, parentSessionId: ent.name, agentType });
    }
  }

  return out;
}

function lookupCommitFileTri(
  repoRoot: string,
  commit: string,
  file: string,
  cache: Map<string, Set<string>>,
): Set<string> {
  const key = `${commit}:${file}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = gitSafe(repoRoot, ['show', `${commit}:${file}`]);
  const tri = raw ? triGrams(raw.split('\n')) : new Set<string>();
  cache.set(key, tri);
  return tri;
}

/**
 * Build tri-grams of 3 consecutive non-blank, whitespace-normalized lines.
 * Tri-grams are coarse enough to skip boilerplate (`}`, `return;`) while
 * being specific enough that random collisions are negligible.
 */
function triGrams(lines: string[]): Set<string> {
  const nonBlank: string[] = [];
  for (const l of lines) {
    const t = normalizeWs(l).trim();
    if (t.length > 0) nonBlank.push(t);
  }
  const out = new Set<string>();
  for (let i = 0; i + 3 <= nonBlank.length; i++) {
    out.add(nonBlank[i] + '\n' + nonBlank[i + 1] + '\n' + nonBlank[i + 2]);
  }
  return out;
}

function normalizeWs(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, '');
}

// ============================================================================
// Git shell-out helpers
// ============================================================================

/**
 * Return the set of commit hashes responsible for the given file (or line
 * range). Uses `git blame --porcelain` and extracts the header lines, which
 * begin with a 40-char hex hash. Surfaces only commits whose authored lines
 * are still present at HEAD.
 */
function blameCommits(repoRoot: string, spec: BlameSpec): Set<string> {
  const args = ['blame', '--porcelain'];
  if (spec.lineStart !== undefined) {
    const end = spec.lineEnd ?? spec.lineStart;
    if (end < spec.lineStart) {
      throw new Error(`blame range end (${end}) is before start (${spec.lineStart})`);
    }
    args.push('-L', `${spec.lineStart},${end}`);
  }
  args.push('--', spec.path);
  const out = gitSafe(repoRoot, args);
  const hashes = new Set<string>();
  if (!out) return hashes;
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40}) \d+ \d+/);
    // Skip the all-zero uncommitted-lines hash so dirty worktrees don't
    // produce a spurious `failed to read commit 0000…` warn per blame run.
    if (m && m[1] !== '0'.repeat(40)) hashes.add(m[1]!);
  }
  return hashes;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitSafe(repoRoot: string, args: string[]): string | null {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/** Re-exported for callers that want the underlying edit shape. */
export type { SessionEdit, SessionEditTrace };
