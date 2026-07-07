/**
 * statusline-segment — pure, dependency-free renderers for the Claude Code
 * status line.
 *
 * LEAF module: imports NOTHING except Node stdlib (`node:path`, for basename).
 * No db, no embedder, no paths.ts. Every function guards every field access and
 * NEVER throws — Claude Code swallows a status-line command's errors (blank bar
 * / notification, not a visible error), so a throw here = a silently dead bar.
 *
 * The wired command is the dedicated `dist/statusline.js` bundle, which imports
 * only this module + `node:process`. Keep this file free of heavy imports so
 * that bundle stays lean (it runs event-driven, up to ~once/second, <100ms).
 *
 * @module recall/statusline-segment
 */

import { basename } from 'node:path';

/** The subset of Claude Code's stdin JSON this feature relies on. Only
 *  `session_id` is guaranteed present; `cwd`/`model` may be absent or null. */
export interface StatuslineInput {
  session_id?: string;
  cwd?: string;
  model?: { display_name?: string };
}

/**
 * recall's segment: just the session-id chip (`🔗 <session_id>`). Empty string
 * if there is no usable session_id. Never throws.
 *
 * The session id is recall's primary key — `recall <id>` reads that session.
 */
export function renderStatuslineSegment(input: StatuslineInput): string {
  const sid = input?.session_id;
  if (typeof sid !== 'string' || sid.length === 0) return '';
  // OSC-8 hyperlink would go here, but it prints raw escapes on
  // Terminal.app / non-supporting terminals — left plain intentionally.
  return `🔗 ${sid}`;
}

/**
 * Full standalone line for a user who had no status line at all. Default shape:
 *   `<basename(cwd)> · <model.display_name> · 🔗 <session_id>`
 * tolerating any missing field (empty parts are dropped). Never throws.
 *
 * A lone UUID as someone's entire status bar is poor UX for a user who had
 * none — this stays modest-but-useful. Flip to the bare chip
 * (`renderStatuslineSegment`) if a strict single-lane line is preferred.
 */
export function renderStandaloneStatusline(input: StatuslineInput): string {
  const parts: string[] = [];

  const cwd = input?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    const dir = basename(cwd);
    if (dir) parts.push(dir);
  }

  const model = input?.model?.display_name;
  if (typeof model === 'string' && model.length > 0) parts.push(model);

  const chip = renderStatuslineSegment(input);
  if (chip) parts.push(chip);

  return parts.join(' · ');
}
