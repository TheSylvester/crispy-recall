/**
 * Transcript Edits — stream Claude Edit/Write/MultiEdit and Codex apply_patch
 * tool calls from raw .jsonl files.
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
import * as path from 'node:path';
import { adaptCodexJsonlRecords } from '../codex/codex-jsonl-adapter.js';
import type { CodexJsonlEnvelope } from '../codex/codex-jsonl-reader.js';

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
  /** Codex child provenance, when present in session_meta. */
  parentSessionId?: string;
  agentType?: string;
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
   * Strip the repo prefix after normalizing separators and drive-letter case,
   * matching git's repo-relative slash paths. Native Windows comparisons are
   * case-insensitive. Without a root, keep the normalized absolute path.
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
  let sessionId = sessionIdFromPath(filePath);
  let codexCwd: string | undefined;
  let parentSessionId: string | undefined;
  let agentType: string | undefined;
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
    if (evt && typeof evt === 'object') {
      const record = evt as CodexJsonlEnvelope;
      if ((record.type === 'session_meta' || record.type === 'turn_context') && record.payload) {
        if (typeof record.payload.cwd === 'string') codexCwd = record.payload.cwd;
        if (record.type === 'session_meta') {
          if (typeof record.payload.id === 'string') sessionId = record.payload.id;
          const source = record.payload.source as { subagent?: { thread_spawn?: Record<string, unknown> }; thread_spawn?: Record<string, unknown> } | undefined;
          const spawn = source?.subagent?.thread_spawn ?? source?.thread_spawn;
          if (typeof spawn?.parent_thread_id === 'string') parentSessionId = spawn.parent_thread_id;
          const role = record.payload.agent_role ?? spawn?.agent_role ?? spawn?.agent_type;
          if (typeof role === 'string') agentType = role;
        }
        continue;
      }
      if (record.type === 'response_item' && record.payload?.type === 'custom_tool_call' && record.payload.name === 'apply_patch') {
        const ts = Date.parse(record.timestamp);
        if (!Number.isFinite(ts)) { skippedEvents++; continue; }
        // Relative patch paths are relative to the turn cwd, which can change
        // within a rollout. Resolve first so another project's src/a.ts cannot match.
        if (!codexCwd) continue;
        for (const entry of adaptCodexJsonlRecords([record], sessionId)) {
          if (!isAssistantEvent(entry)) continue;
          for (const block of entry.message.content) {
            if (!isToolUseBlock(block) || !block.input) continue;
            const input = block.input as { file_path?: unknown; new_string?: unknown; content?: unknown };
            if (typeof input.file_path !== 'string') continue;
            const raw = input.file_path.replace(/\\/g, '/');
            const absolute = /^(?:[a-z]:\/|\/)/i.test(raw) ? raw : path.posix.join(codexCwd.replace(/\\/g, '/'), raw);
            pushEdit(absolute, input.new_string ?? input.content, ts);
          }
        }
        continue;
      }
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
      if (!input) continue;
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

  return { sessionId, edits, firstTs, lastTs, skippedLines, skippedEvents, ...(parentSessionId ? { parentSessionId } : {}), ...(agentType ? { agentType } : {}) };
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

export function normalizePath(p: string, repoRoot: string | undefined): string {
  const normalized = p.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase() + ':');
  if (!repoRoot) return normalized;
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase() + ':');
  const insensitive = process.platform === 'win32';
  const candidate = insensitive ? normalized.toLowerCase() : normalized;
  const prefix = insensitive ? root.toLowerCase() : root;
  if (candidate.startsWith(prefix + '/')) return normalized.slice(root.length + 1);
  if (candidate === prefix) return '';
  return normalized;
}
