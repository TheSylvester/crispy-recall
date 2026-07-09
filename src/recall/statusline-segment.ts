/**
 * statusline-segment — pure, dependency-free renderers for the Claude Code
 * status line.
 *
 * LEAF module: imports NOTHING except Node stdlib (`node:path`, for basename).
 * No db, no embedder, no paths.ts, no child_process. Every function guards every
 * field access and NEVER throws — Claude Code swallows a status-line command's
 * errors (blank bar / notification, not a visible error), so a throw here = a
 * silently dead bar.
 *
 * The wired command is the dedicated `dist/statusline.js` bundle, which imports
 * only this module + `node:process` + a single time-boxed `git` call (done in
 * the ENTRY, `hooks/statusline.ts`, never here — this file stays pure/no-IO).
 * Keep it free of heavy imports so the bundle stays lean (it runs event-driven,
 * up to ~once/second, <100ms).
 *
 * @module recall/statusline-segment
 */

import { basename } from 'node:path';

/** The subset of Claude Code's stdin JSON this feature relies on. Only
 *  `session_id` is guaranteed present; everything else may be absent or null. */
export interface StatuslineInput {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string };
  context_window?: {
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
}

/** Git state for the directory segment, gathered by the entry (never here). */
export interface GitInfo {
  branch: string;
  dirty: boolean;
}

/** Extra, non-stdin inputs the entry computes and hands to the renderer. */
export interface StandaloneOpts {
  git?: GitInfo;
}

// --- muted ANSI palette ------------------------------------------------------
// "Less colorful": everything is dim/soft; only the context meter escalates —
// its whole job is to warn as the window fills. Every colored span is closed
// with RESET so a segment can never bleed into the next.
const RESET = '\x1b[0m';
const DIM = '\x1b[2;37m'; // dim grey — separators, dir, model version, session id
const SOFT = '\x1b[37m'; // light grey — model name
const GREEN = '\x1b[32m'; // git branch (normal, not bright)
const RED = '\x1b[31m'; // git dirty marker

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

/**
 * recall's segment: just the session-id chip (`🔗 <session_id>`), PLAIN (no
 * color). Empty string if there is no usable session_id. Never throws.
 *
 * Kept color-free on purpose: this is the chip the `recall statusline`
 * subcommand and the "add it to your own line" paste-snippets hand to a FOREIGN
 * status line, which brings its own colors. The wired standalone line applies
 * its own muted tone (see renderStandaloneStatusline / renderChip).
 *
 * The session id is recall's primary key — `recall <id>` reads that session.
 */
export function renderStatuslineSegment(input: StatuslineInput): string {
  const sid = input?.session_id;
  if (typeof sid !== 'string' || sid.length === 0) return '';
  return `🔗 ${sid}`;
}

/** `Opus 🧠 4.8` — family icon + dim version. '' when no display_name.
 *  Family and version are found INDEPENDENTLY of position, so both name-first
 *  ("Opus 4.8") and version-first ("3.5 Haiku") legacy display names resolve to
 *  `<family> <icon> <version>`; a parenthetical suffix ("(1M context)") is
 *  dropped. A non-Claude name with no family keyword keeps its cleaned text. */
function renderModel(input: StatuslineInput): string {
  const raw = input?.model?.display_name;
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const cleaned = raw.replace('Claude ', '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (cleaned.length === 0) return '';
  const family = /Opus/i.test(cleaned)
    ? 'Opus'
    : /Sonnet/i.test(cleaned)
      ? 'Sonnet'
      : /Haiku/i.test(cleaned)
        ? 'Haiku'
        : undefined;
  const icon = family === 'Opus' ? '🧠' : family === 'Haiku' ? '💲' : '⚡';
  const version = /(\d+\.?\d*)/.exec(cleaned)?.[1];
  if (family && version) return `${SOFT}${family}${RESET} ${icon} ${dim(version)}`;
  // Non-Claude or version-less: keep the cleaned name + icon (no split, so a
  // name like "GPT-5" stays intact rather than becoming "GPT- ⚡ 5").
  return `${SOFT}${family ?? cleaned}${RESET} ${icon}`;
}

/** `💿 34%` with a muted threshold scale. '' when there is no REAL reading:
 *  context_window / current_usage absent (older Claude Code), a non-positive /
 *  missing window size, or a current_usage carrying no numeric token field —
 *  all degrade the segment away rather than show a misleading `💿 0%`. Every
 *  token field is coerced numerically, so a hostile non-numeric value is
 *  ignored instead of producing `💿 NaN%`. */
function renderContext(input: StatuslineInput): string {
  const ctx = input?.context_window;
  const usage = ctx?.current_usage;
  if (!ctx || usage === undefined || usage === null || typeof usage !== 'object') return '';
  const window = Number(ctx.context_window_size);
  if (!Number.isFinite(window) || window <= 0) return '';
  const fields = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  const present = fields.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length === 0) return '';
  const tokens = present.reduce((a, b) => a + b, 0);
  const pct = Math.floor((tokens * 100) / window);
  const color =
    pct >= 81
      ? '\x1b[1;31m' // bold red — critical
      : pct >= 61
        ? '\x1b[31m' // red
        : pct >= 41
          ? '\x1b[33m' // yellow
          : pct >= 21
            ? '\x1b[32m' // green
            : pct >= 11
              ? '\x1b[37m' // grey
              : '\x1b[2;37m'; // dim
  return `💿 ${color}${pct}%${RESET}`;
}

/** `recall (main*)` — dim basename + optional git branch/dirty suffix (the
 *  suffix hugs the dir with no separator, like the source line). */
function renderDir(input: StatuslineInput, git?: GitInfo): string {
  const cwd = input?.workspace?.current_dir ?? input?.cwd;
  let dir = '';
  if (typeof cwd === 'string' && cwd.length > 0) {
    const base = basename(cwd);
    if (base) dir = dim(base);
  }
  if (git && git.branch) {
    const star = git.dirty ? `${RED}*${RESET}` : '';
    const suffix = `(${GREEN}${git.branch}${RESET}${star})`;
    return dir ? `${dir} ${suffix}` : suffix;
  }
  return dir;
}

/** `🔗 <sid>` in dim grey (was bright magenta in the source line). '' if none. */
function renderChip(input: StatuslineInput): string {
  const sid = input?.session_id;
  if (typeof sid !== 'string' || sid.length === 0) return '';
  return `🔗 ${dim(sid)}`;
}

/**
 * Full standalone line for a user who had no status line at all. Muted, dot-
 * separated:
 *   `<dir> (<branch>*) · <Model> 🧠 <ver> · 💿 <ctx>% · 🔗 <session_id>`
 * Every segment is dropped when its data is missing; never throws.
 *
 * `opts.git` is supplied by the entry (a time-boxed git read); omit it and the
 * git suffix simply disappears.
 */
export function renderStandaloneStatusline(input: StatuslineInput, opts?: StandaloneOpts): string {
  const parts: string[] = [];

  const dir = renderDir(input, opts?.git);
  if (dir) parts.push(dir);

  const model = renderModel(input);
  if (model) parts.push(model);

  const ctx = renderContext(input);
  if (ctx) parts.push(ctx);

  const chip = renderChip(input);
  if (chip) parts.push(chip);

  return parts.join(` ${DIM}·${RESET} `);
}
