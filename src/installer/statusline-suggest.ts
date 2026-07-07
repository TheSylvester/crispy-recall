/**
 * statusline-suggest — classify the user's existing Claude Code statusLine and
 * build the "recall won't touch it, here's how to add the session id yourself"
 * message (BOTH a paste-snippet and a ready-to-run `claude -p` prompt).
 *
 * recall NEVER runs an LLM itself and NEVER edits a foreign statusLine. When a
 * user already has one, the installer (and `recall statusline --suggest`) print
 * this guidance and let the user decide.
 *
 * @module installer/statusline-suggest
 */

import { existsSync, readFileSync } from 'node:fs';
import { isRecallStatusLine, classifyStatusLineSlot } from './settings-merge.js';

export type StatuslineKind =
  | 'none'        // no statusLine key, or command missing/blank  → recall may write
  | 'recall'      // isRecallStatusLine(command) === true          → already ours
  | 'python'
  | 'node'
  | 'shell'
  | 'thirdparty'
  | 'unknown';    // foreign → never touch

export interface DetectedStatusline {
  present: boolean;
  command?: string;    // obj.statusLine.command as-read
  kind: StatuslineKind;
  scriptPath?: string; // best-effort file path extracted from command, if any
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Tolerant read of a settings.json: strict JSON, then a comment-strip fallback.
 *  Returns null when the file is absent/empty, and 'unparseable' when it exists
 *  but cannot be read as JSON — the two must not be conflated: an unparseable
 *  file may well CONTAIN a statusline, so it is not "none" (never throws). */
function readSettings(settingsPath: string): { statusLine?: unknown } | 'unparseable' | null {
  if (!existsSync(settingsPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch {
    return 'unparseable';
  }
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as { statusLine?: unknown };
  } catch {
    try {
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1');
      return JSON.parse(stripped) as { statusLine?: unknown };
    } catch {
      return 'unparseable';
    }
  }
}

/** Split a command into tokens, honoring single/double quotes so a quoted path
 *  containing spaces survives as one token. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Best-effort: first token ending in a known script extension (quotes stripped). */
function extractScriptPath(cmd: string): string | undefined {
  for (const tok of tokenize(cmd)) {
    if (/\.(py|mjs|cjs|js|sh)$/i.test(tok)) return tok;
  }
  return undefined;
}

/**
 * Classify a statusLine command. Order matters: recall first (its own command
 * contains `node` + `.js`), then thirdparty (npx/ccusage etc.), then the
 * extension/interpreter heuristics.
 */
function classify(cmd: string): StatuslineKind {
  if (isRecallStatusLine(cmd)) return 'recall';
  if (/\b(ccusage|ccstatusline|claude-powerline|npx|bunx|pnpm dlx)\b/.test(cmd)) return 'thirdparty';
  if (/\.py(\b|['"\s]|$)/.test(cmd) || /\bpython/.test(cmd)) return 'python';
  if (/\.[mc]?js(\b|['"\s]|$)/.test(cmd) || /\bnode\b/.test(cmd)) return 'node';
  if (/\.sh(\b|['"\s]|$)/.test(cmd) || /\b(bash|sh|zsh)\b/.test(cmd)) return 'shell';
  return 'unknown';
}

/** Read `settingsPath` (tolerant) and classify the current statusLine. Uses the
 *  same slot classifier as mergeStatusLine so detect and merge cannot disagree:
 *  a present-but-unreadable shape is FOREIGN ('unknown'), never 'none'. */
export function detectStatusline(settingsPath: string): DetectedStatusline {
  const settings = readSettings(settingsPath);
  // An unparseable settings.json may well contain a statusline — report it as
  // present/unknown (recall backs off) instead of "you have none" guidance
  // that recommends an install which would fail on the same file.
  if (settings === 'unparseable') return { present: true, kind: 'unknown' };
  const slot = classifyStatusLineSlot(settings?.statusLine);
  if (slot === 'empty') return { present: false, kind: 'none' };
  if (slot === 'unreadable') return { present: true, kind: 'unknown' };
  const command = slot.cmd;
  const kind = classify(command);
  const scriptPath = extractScriptPath(command);
  return { present: true, command, kind, ...(scriptPath ? { scriptPath } : {}) };
}

// ---------------------------------------------------------------------------
// The "both options" message
// ---------------------------------------------------------------------------

const PYTHON_SNIPPET = [
  'sid = data.get("session_id") or ""',
  'if sid:',
  '    parts.append(f"🔗 {sid}")   # adjust to your line assembly',
].join('\n');

const NODE_SNIPPET = [
  'const sid = input.session_id || "";',
  'if (sid) parts.push(`🔗 ${sid}`);   // adjust to your line assembly',
].join('\n');

const SHELL_SNIPPET = [
  "sid=$(printf '%s' \"$input\" | jq -r '.session_id // empty')",
  "[ -n \"$sid\" ] && printf ' 🔗 %s' \"$sid\"",
].join('\n');

const EXTERNAL_SNIPPET = [
  "Your statusline is produced by an external command, so there's no file to edit.",
  'If it supports custom segments, add the top-level "session_id" from the stdin JSON.',
  'Or switch to a script that also runs `recall statusline` and appends its output.',
].join('\n');

function optionASnippet(kind: StatuslineKind): string {
  switch (kind) {
    case 'python': return PYTHON_SNIPPET;
    case 'node': return NODE_SNIPPET;
    case 'shell': return SHELL_SNIPPET;
    default: return EXTERNAL_SNIPPET; // thirdparty / unknown
  }
}

function optionBPrompt(d: DetectedStatusline): string {
  if (d.scriptPath) {
    return [
      `claude -p 'Edit my Claude Code statusline script at ${d.scriptPath} so it appends a`,
      '"🔗 <session_id>" segment. The script receives a JSON object on stdin with a',
      'top-level "session_id" string field (always present). Keep the existing layout and',
      "colors; add the id as a new trailing segment. Show me the diff before writing.'",
      '',
      '…or paste that prompt into an interactive Claude session and review the change before saving.',
    ].join('\n');
  }
  return [
    `claude -p 'My Claude Code statusLine command is: ${d.command ?? ''}. Show me how to add a`,
    '"🔗 <session_id>" segment (session_id is a top-level field of the JSON piped to the',
    "statusline on stdin), without breaking my current statusline.'",
  ].join('\n');
}

const TIP = [
  'Tip: `recall statusline` reads the same stdin JSON and prints just "🔗 <session_id>".',
  'Re-run `recall statusline --suggest` anytime to see this again.',
].join('\n');

/**
 * The message shown for a FOREIGN status line: recall-won't-touch note +
 * Option A (paste-snippet, tailored to kind) + Option B (`claude -p` prompt) +
 * the `recall statusline`/`--suggest` tip. For an EMPTY slot or a recall-owned
 * one (only reachable via `--suggest`), returns a short state-appropriate note.
 */
export function renderStatuslineSuggestion(d: DetectedStatusline): string {
  if (d.kind === 'recall') {
    return [
      'recall already manages your Claude Code statusline — the session id is shown as "🔗 <session_id>".',
      TIP,
    ].join('\n\n');
  }
  if (d.kind === 'none' || !d.present) {
    return [
      'You have no Claude Code statusline set.',
      'Run `recall install --statusline` to show the session id (recall\'s primary key: `recall <id>`) in your status bar.',
      TIP,
    ].join('\n\n');
  }

  return [
    `recall won't change your statusline — you already have one:\n  ${d.command ?? '(statusLine is set in settings.json, but in a format recall does not read)'}`,
    'To also show the session id (recall\'s primary key: `recall <id>`), pick either:',
    `── Option A · paste a snippet into your statusline ──\n${optionASnippet(d.kind)}`,
    `── Option B · let Claude edit it for you (review the diff before saving!) ──\n${optionBPrompt(d)}`,
    TIP,
  ].join('\n\n');
}
