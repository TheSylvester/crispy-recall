/**
 * settings-merge — idempotent JSON hook merge for ~/.claude/settings.json
 * and ~/.codex/hooks.json.
 *
 * Treats any existing array entry whose `command` references the recall
 * stop-hook script — at ANY path — as a recall entry it owns. Running
 * `install` twice produces the same file as running it once. Preserves the
 * file's dominant line ending and indentation; backs up before the first edit.
 *
 * @module installer/settings-merge
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { stableNodePath } from './stable-node.js';
import { readConfig } from './config.js';
import { statuslineScript } from '../paths.js';

const HOOK_ARRAYS = ['Stop', 'SubagentStop'] as const;

/**
 * Write `contents` to `path` atomically: write a sibling temp file on the same
 * filesystem, then `renameSync` it into place (atomic on POSIX/Windows). A
 * crash or ENOSPC mid-write corrupts only the temp file, never the target —
 * critical for files like ~/.claude/settings.json that gate app startup. On
 * any failure the temp file is best-effort removed. The caller keeps owning
 * the `.bak` backup; this only changes the final write to be crash-safe.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

interface HookCommand { type?: string; command?: string }
interface HookEntry { matcher?: string; hooks?: HookCommand[] }
interface StatusLineShape { type?: string; command?: string }
interface SettingsShape { hooks?: Record<string, HookEntry[]>; statusLine?: StatusLineShape; [k: string]: unknown }

export interface MergeResult { changed: boolean; backup?: string }

/** Filesystem-safe ISO stamp for `.bak.<stamp>` files (no `:` for Windows). */
export function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copy `path` to `<path>.bak.<stamp>` and return the backup path. */
export function backupFile(path: string): string {
  const dest = `${path}.bak.${backupStamp()}`;
  copyFileSync(path, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Formatting preservation
// ---------------------------------------------------------------------------

function detectLineEnding(raw: string): '\r\n' | '\n' {
  return raw.includes('\r\n') ? '\r\n' : '\n';
}

/** Detect indentation from the first indented line; default 2 spaces. */
function detectIndent(raw: string): string | number {
  const m = raw.match(/\n([\t ]+)\S/);
  if (!m) return 2;
  const ws = m[1]!;
  if (ws.includes('\t')) return '\t';
  return ws.length;
}

/** Tolerant parse: strict JSON first, then a minimal comment-strip fallback. */
function parseTolerant(raw: string): SettingsShape {
  try {
    return JSON.parse(raw) as SettingsShape;
  } catch {
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1');
    return JSON.parse(stripped) as SettingsShape;
  }
}

function serialize(obj: SettingsShape, raw: string | null): string {
  const indent = raw ? detectIndent(raw) : 2;
  const ending = raw ? detectLineEnding(raw) : '\n';
  const body = JSON.stringify(obj, null, indent);
  return body.replace(/\n/g, ending) + ending;
}

// ---------------------------------------------------------------------------
// Recall-entry detection (path-independent)
// ---------------------------------------------------------------------------

/** A command is a recall stop-hook if it references stop-hook.js AND carries a
 *  `recall` marker in the path — catches stale entries at a different path. */
function isRecallCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return /stop-hook\.js/.test(cmd) && /recall/i.test(cmd);
}

function findRecallEntry(arr: HookEntry[]): { entry: HookEntry; cmd: HookCommand } | null {
  for (const entry of arr) {
    const hooks = entry.hooks;
    if (!Array.isArray(hooks)) continue;
    const cmd = hooks.find((h) => isRecallCommand(h.command));
    if (cmd) return { entry, cmd };
  }
  return null;
}

function makeEntry(command: string): HookEntry {
  return { matcher: '', hooks: [{ type: 'command', command }] };
}

// ---------------------------------------------------------------------------
// Merge / remove
// ---------------------------------------------------------------------------

/**
 * Merge the recall Stop + SubagentStop hook into the JSON file at `filePath`.
 * Idempotent; auto-heals a stale recall path in place. Creates the file if
 * absent. `hookScriptPath` is the absolute path to the staged stop-hook.js.
 */
export function mergeStopHook(filePath: string, hookScriptPath: string): MergeResult {
  // Pin the installing Node's absolute path (not a bare `node`). The
  // better-sqlite3 addon is ABI-locked to the Node it was built for, so the
  // hook must run under that exact interpreter — a PATH `node` that later
  // points at a different major would fail to load the binding. Use the
  // upgrade-stable public path (stableNodePath): process.execPath resolves to
  // the versioned Homebrew Cellar, which `brew upgrade node` deletes, so pin
  // the shim that survives upgrades instead (a no-op off Homebrew). Quote BOTH
  // paths: ~/.recall or a user home can contain spaces. `isRecallCommand` is
  // path-based (matches stop-hook.js + a recall marker), so it still recognizes
  // this pinned form and heals a stale command in place (idempotent when the
  // pinned node is unchanged; rewrites on an ABI/node-path change).
  const desiredCommand = `"${stableNodePath()}" "${hookScriptPath}"`;
  const exists = existsSync(filePath);
  const raw = exists ? readFileSync(filePath, 'utf-8') : null;
  const obj: SettingsShape = raw && raw.trim().length > 0 ? parseTolerant(raw) : {};

  if (!obj.hooks || typeof obj.hooks !== 'object') obj.hooks = {};

  let changed = false;
  for (const name of HOOK_ARRAYS) {
    const arr = Array.isArray(obj.hooks[name]) ? obj.hooks[name]! : [];
    const found = findRecallEntry(arr);
    if (!found) {
      arr.push(makeEntry(desiredCommand));
      changed = true;
    } else if (found.cmd.command !== desiredCommand) {
      // Stale recall path → rewrite in place (do not duplicate, do not touch siblings).
      found.cmd.command = desiredCommand;
      changed = true;
    }
    obj.hooks[name] = arr;
  }

  if (!changed && exists) return { changed: false };

  let backup: string | undefined;
  if (exists) backup = backupFile(filePath);
  writeFileAtomic(filePath, serialize(obj, raw));
  return backup ? { changed: true, backup } : { changed: true };
}

/**
 * Remove recall Stop + SubagentStop entries from `filePath` (path-independent).
 * Drops a now-empty Stop/SubagentStop key. Leaves everything else alone.
 */
export function removeStopHook(filePath: string): MergeResult {
  if (!existsSync(filePath)) return { changed: false };
  const raw = readFileSync(filePath, 'utf-8');
  if (raw.trim().length === 0) return { changed: false };
  const obj = parseTolerant(raw);
  if (!obj.hooks || typeof obj.hooks !== 'object') return { changed: false };

  let changed = false;
  for (const name of HOOK_ARRAYS) {
    const arr = obj.hooks[name];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((entry) => {
      const hooks = entry.hooks;
      const isRecall = Array.isArray(hooks) && hooks.some((h) => isRecallCommand(h.command));
      if (isRecall) changed = true;
      return !isRecall;
    });
    if (kept.length === 0) {
      delete obj.hooks[name];
    } else {
      obj.hooks[name] = kept;
    }
  }

  if (!changed) return { changed: false };
  const backup = backupFile(filePath);
  writeFileAtomic(filePath, serialize(obj, raw));
  return { changed: true, backup };
}

// ---------------------------------------------------------------------------
// statusLine — a SINGLE object, not an array (unlike the hook helpers above).
//
// Claude Code allows exactly one `statusLine` command per settings scope, so
// writing it means overwriting whatever is there. Many power users curate a
// status line; clobbering it is unacceptable. The one rule: recall writes ONLY
// into a genuinely EMPTY slot, or heals a slot it already owns. A foreign value
// is NEVER modified.
// ---------------------------------------------------------------------------

/**
 * Classify the raw `statusLine` value.
 *   'empty'      — genuinely nothing to preserve: key absent, null, or an
 *                  object whose command is absent/null/blank.
 *   'unreadable' — PRESENT user content in a shape we can't read (a string
 *                  value, an array, a non-string command, …). Treated as
 *                  foreign downstream: it may be a hand-edit the user meant,
 *                  so it is never overwritten.
 *   { cmd }      — a readable command string.
 */
export type StatusLineSlot = 'empty' | 'unreadable' | { cmd: string };

export function classifyStatusLineSlot(sl: unknown): StatusLineSlot {
  if (sl === undefined || sl === null) return 'empty';
  if (typeof sl === 'object' && !Array.isArray(sl)) {
    const c = (sl as { command?: unknown }).command;
    if (c === undefined || c === null) return 'empty';
    if (typeof c === 'string') return c.trim().length === 0 ? 'empty' : { cmd: c };
    return 'unreadable';
  }
  return 'unreadable';
}

/**
 * A statusLine command is recall's iff it is EXACTLY the two-token shape recall
 * writes — `"<node>" "<…statusline.js>"` — AND the script resolves to recall's:
 * a `.recall/` path marker (survives a lost config.json, like isRecallCommand),
 * the live statuslineScript() location (honors a custom RECALL_HOME), or the
 * exact command recorded in config.json.
 *
 * Anchoring on the FULL shape is load-bearing: statusLine is a single slot, so
 * a user command that merely EMBEDS recall's script (e.g. a composite
 * `sh -c 'their-tool; "<node>" "<…statusline.js>"'`) must stay foreign —
 * claiming it would rewrite or delete the user's half on heal/uninstall.
 */
export function isRecallStatusLine(cmd?: string): boolean {
  if (!cmd) return false;
  const m = /^\s*"([^"]+)"\s+"([^"]+statusline\.js)"\s*$/.exec(cmd);
  if (!m) return false;
  const script = m[2]!;
  // Full `.recall` path segment — a dir merely SUFFIXED `.recall`
  // (e.g. backups.recall/) is somebody else's.
  if (/(^|[\\/])\.recall[\\/]/.test(script)) return true;
  if (script === statuslineScript()) return true;
  const recorded = readConfig()?.statusline?.command;
  return recorded !== undefined && cmd === recorded;
}

export type MergeStatusLineResult =
  | { state: 'wroteEmpty'; changed: true; backup?: string }      // slot was empty → wrote recall command
  | { state: 'alreadyRecall'; changed: boolean; backup?: string } // healed the pin in place, or no-op
  | { state: 'refusedForeign'; changed: false };                  // foreign value present → untouched

/**
 * Write recall's `statusLine` command ONLY into an empty-or-already-recall slot.
 * NEVER overwrites a foreign value. Idempotent; heals a drifted recall pin in
 * place (mirrors mergeStopHook's stale-path branch). Creates the file if absent.
 */
export function mergeStatusLine(filePath: string, command: string): MergeStatusLineResult {
  const exists = existsSync(filePath);
  const raw = exists ? readFileSync(filePath, 'utf-8') : null;
  const obj: SettingsShape = raw && raw.trim().length > 0 ? parseTolerant(raw) : {};

  const slot = classifyStatusLineSlot(obj.statusLine);

  // Keep user-added sibling keys (Claude Code supports e.g. `padding`) when
  // writing into an empty-but-object slot or healing an owned one.
  const siblings = obj.statusLine && typeof obj.statusLine === 'object' && !Array.isArray(obj.statusLine)
    ? (obj.statusLine as Record<string, unknown>)
    : {};

  // Empty slot (absent / null / blank command) → write recall's command.
  if (slot === 'empty') {
    obj.statusLine = { ...siblings, type: 'command', command };
    const backup = exists ? backupFile(filePath) : undefined;
    writeFileAtomic(filePath, serialize(obj, raw));
    return backup ? { state: 'wroteEmpty', changed: true, backup } : { state: 'wroteEmpty', changed: true };
  }

  // Present but unreadable → user content in a shape we don't understand;
  // refuse like any foreign value rather than misread it as empty.
  if (slot === 'unreadable') return { state: 'refusedForeign', changed: false };

  // Already recall's → no-op if unchanged, else heal the pinned node / path.
  if (isRecallStatusLine(slot.cmd)) {
    if (slot.cmd === command) return { state: 'alreadyRecall', changed: false };
    obj.statusLine = { ...siblings, type: 'command', command };
    const backup = backupFile(filePath);
    writeFileAtomic(filePath, serialize(obj, raw));
    return { state: 'alreadyRecall', changed: true, backup };
  }

  // Populated with a foreign value → never touch it.
  return { state: 'refusedForeign', changed: false };
}

/**
 * Remove recall's `statusLine` iff we still own it (isRecallStatusLine PRIMARY —
 * a lost config.json must still allow cleanup). Restores a stashed prior value
 * if config recorded one, else deletes the key. Leaves a foreign value alone.
 */
export function removeStatusLine(filePath: string): MergeResult {
  if (!existsSync(filePath)) return { changed: false };
  const raw = readFileSync(filePath, 'utf-8');
  if (raw.trim().length === 0) return { changed: false };
  const obj = parseTolerant(raw);
  const slot = classifyStatusLineSlot(obj.statusLine);
  if (slot === 'empty' || slot === 'unreadable' || !isRecallStatusLine(slot.cmd)) return { changed: false };

  const prior = readConfig()?.statusline?.priorStatusLine ?? null;
  if (prior) obj.statusLine = prior;
  else delete obj.statusLine;

  const backup = backupFile(filePath);
  writeFileAtomic(filePath, serialize(obj, raw));
  return { changed: true, backup };
}
