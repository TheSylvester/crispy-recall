/**
 * Transcript Edits — extract Edit/Write/MultiEdit tool calls from raw Claude
 * Code .jsonl files.
 *
 * Stream-parses a single jsonl session file and returns the file-edit events
 * (with timestamps + content) that the assistant emitted. Used by structural
 * matchers that need to compare what a session typed against git diffs.
 *
 * Scope: pure parsing. Input is an absolute path to a .jsonl file. Output is
 * a list of edits + skip counters for diagnostics. No I/O beyond the read
 * stream; no DB lookups; no Claude/Codex SDK dependency.
 *
 * Boundary: this module does NOT interpret edits (no diff matching, no
 * normalization beyond path stripping). Consumers downstream do that.
 *
 * @module adapters/claude/transcript-edits
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

// ============================================================================
// Types
// ============================================================================

export interface SessionEdit {
  /** Repo-relative file path (or absolute if `repoRoot` didn't match). */
  file: string;
  /** The new content the tool call wrote (Edit.new_string, Write.content, MultiEdit.edits[i].new_string). */
  content: string;
  /** Assistant event timestamp, epoch ms. */
  ts: number;
}

export interface SessionEditTrace {
  /** Filename basename without `.jsonl` (UUID for top-level, `agent-<hash>` for subagents). */
  sessionId: string;
  edits: SessionEdit[];
  /** Earliest edit timestamp, or `Infinity` if no edits. */
  firstTs: number;
  /** Latest edit timestamp, or `-Infinity` if no edits. */
  lastTs: number;
  /** Lines we couldn't JSON.parse. */
  skippedLines: number;
  /** Assistant events we skipped due to missing/invalid timestamp. */
  skippedEvents: number;
}

export interface ExtractOptions {
  /**
   * If set, file paths starting with `repoRoot + '/'` are stripped of the
   * prefix so downstream code can match against `git diff`'s repo-relative
   * paths. Without it, the absolute path is kept.
   */
  repoRoot?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Stream-parse a jsonl session file and extract Edit/Write/MultiEdit tool
 * calls. Designed for memory efficiency on large sessions (some are 100MB+).
 */
export async function extractSessionEdits(
  filePath: string,
  opts: ExtractOptions = {},
): Promise<SessionEditTrace> {
  const sessionId = sessionIdFromPath(filePath);
  const edits: SessionEdit[] = [];
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let skippedLines = 0;
  let skippedEvents = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const pushEdit = (fp: unknown, cnt: unknown, ts: number) => {
    if (typeof fp !== 'string' || typeof cnt !== 'string') return;
    edits.push({ file: normalizePath(fp, opts.repoRoot), content: cnt, ts });
    if (ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    if (!isAssistantEvent(evt)) continue;
    const ts = parseTimestamp(evt);
    if (!Number.isFinite(ts)) {
      skippedEvents++;
      continue;
    }
    for (const block of evt.message.content) {
      if (!isToolUseBlock(block)) continue;
      const input = block.input;
      if (block.name === 'Edit') {
        pushEdit((input as { file_path?: unknown }).file_path, (input as { new_string?: unknown }).new_string, ts);
      } else if (block.name === 'Write') {
        pushEdit((input as { file_path?: unknown }).file_path, (input as { content?: unknown }).content, ts);
      } else if (block.name === 'MultiEdit') {
        const fp = (input as { file_path?: unknown }).file_path;
        const edArr = (input as { edits?: unknown }).edits;
        if (Array.isArray(edArr)) {
          for (const e of edArr) {
            if (e && typeof e === 'object') {
              pushEdit(fp, (e as { new_string?: unknown }).new_string, ts);
            }
          }
        }
      }
    }
  }

  return { sessionId, edits, firstTs, lastTs, skippedLines, skippedEvents };
}

/**
 * Derive the session ID from a jsonl path. Strips the `.jsonl` extension and
 * returns the basename. For top-level sessions this is a UUID; for subagent
 * files in `<project>/<parent>/subagents/agent-<hash>.jsonl` it's
 * `agent-<hash>`.
 */
export function sessionIdFromPath(filePath: string): string {
  const base = filePath.replace(/^.*[\\/]/, '');
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

// ============================================================================
// Internals
// ============================================================================

interface AssistantEvent {
  type: 'assistant';
  timestamp?: unknown;
  message: { content: unknown[] };
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input?: unknown;
}

function isAssistantEvent(evt: unknown): evt is AssistantEvent {
  if (!evt || typeof evt !== 'object') return false;
  const e = evt as { type?: unknown; message?: unknown };
  if (e.type !== 'assistant') return false;
  const m = e.message as { content?: unknown } | undefined;
  return !!m && Array.isArray(m.content);
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: unknown; name?: unknown; input?: unknown };
  if (b.type !== 'tool_use') return false;
  if (typeof b.name !== 'string') return false;
  if (b.input && typeof b.input !== 'object') return false;
  return true;
}

function parseTimestamp(evt: AssistantEvent): number {
  if (typeof evt.timestamp !== 'string') return NaN;
  return new Date(evt.timestamp).getTime();
}

function normalizePath(p: string, repoRoot: string | undefined): string {
  if (!repoRoot) return p;
  const prefix = repoRoot.endsWith('/') ? repoRoot : repoRoot + '/';
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  if (p === repoRoot) return '';
  return p;
}
