/**
 * claudemd-nudge — idempotent CLAUDE.md / AGENTS.md edits.
 *
 * The manifest's single OPT-OUT item: append a short "## Recall" block telling
 * the agent to use the recall skill before non-trivial work. Idempotent (skips
 * if a `## Recall` heading already exists); preserves line endings + trailing
 * newline; backs up before the first edit. Uninstall removes the block.
 *
 * The selection/consent logic lives in install.ts; this module just performs
 * the edit when invoked.
 *
 * @module installer/claudemd-nudge
 */

import { existsSync, readFileSync } from 'node:fs';
import { backupFile, writeFileAtomic } from './settings-merge.js';

const RECALL_BLOCK = [
  '',
  '## Recall',
  '',
  '- At the start of non-trivial tasks and before architectural decisions,',
  '  use the `recall` skill to search past sessions for prior context.',
  '',
].join('\n');

const RECALL_HEADING = /^## Recall\s*$/m;

/** Append the Recall nudge to `filePath` unless it is already present. */
export function applyNudge(filePath: string): { changed: boolean; backup?: string } {
  const exists = existsSync(filePath);
  const raw = exists ? readFileSync(filePath, 'utf-8') : '';

  if (RECALL_HEADING.test(raw)) return { changed: false };

  const ending = raw.includes('\r\n') ? '\r\n' : '\n';
  // Normalize the block to the file's line ending; ensure a separating newline.
  const block = RECALL_BLOCK.replace(/\n/g, ending);
  const needsLeadingNl = raw.length > 0 && !raw.endsWith('\n') && !raw.endsWith('\r\n');
  const next = (needsLeadingNl ? raw + ending : raw) + block;

  let backup: string | undefined;
  if (exists) backup = backupFile(filePath);
  writeFileAtomic(filePath, next.endsWith(ending) ? next : next + ending);
  return backup ? { changed: true, backup } : { changed: true };
}

/**
 * Remove the Recall block: from the `## Recall` heading up to (but not
 * including) the next top/section heading (`^#{1,2} `) or EOF, so nested
 * `###` sub-headings under Recall are removed with it. Leaves the rest alone.
 */
export function removeNudge(filePath: string): { changed: boolean; backup?: string } {
  if (!existsSync(filePath)) return { changed: false };
  const raw = readFileSync(filePath, 'utf-8');
  if (!RECALL_HEADING.test(raw)) return { changed: false };

  const ending = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const start = lines.findIndex((l) => /^## Recall\s*$/.test(l));
  if (start < 0) return { changed: false };

  // Find the end: next line that is a top- or section-level heading.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) { end = i; break; }
  }

  // Also swallow a single blank separator line immediately before the block.
  let removeFrom = start;
  if (removeFrom > 0 && lines[removeFrom - 1]!.trim() === '') removeFrom -= 1;

  const kept = [...lines.slice(0, removeFrom), ...lines.slice(end)];
  // Collapse a trailing run of blank lines to a single trailing newline.
  while (kept.length > 1 && kept[kept.length - 1] === '' && kept[kept.length - 2] === '') kept.pop();

  let next = kept.join(ending);
  if (next.length > 0 && !next.endsWith(ending)) next += ending;

  const backup = backupFile(filePath);
  writeFileAtomic(filePath, next);
  return { changed: true, backup };
}
