/**
 * Transcript Utilities — Content filtering for recall pipelines
 *
 * Reusable transformations on TranscriptEntry arrays for chunking and
 * embedding workflows. Extracted from the backfill script so both
 * real-time and batch pipelines share the same logic.
 *
 * Scope: pure data transformation. No I/O, no persistence, no side effects.
 * Boundary: takes TranscriptEntry[], returns TranscriptEntry[].
 *
 * @module recall/transcript-utils
 */

import type { TranscriptEntry } from '../transcript.js';
import { firstTextContent } from '../adapters/system-context.js';

// ============================================================================
// Public API
// ============================================================================

/** Meta entries whose first text starts with one of these prefixes are KEPT (real signal). */
export const META_KEEP_PREFIXES = [
  '<task-notification>',
  '[SYSTEM NOTIFICATION',
  'Another Claude session sent a message',
] as const;

/**
 * True when an adapted entry is machine boilerplate that must not be indexed.
 * Semantics: entry.isMeta === true AND the entry's first text content (string
 * content, or the first text block of array content) does not start with any
 * META_KEEP_PREFIXES entry. Entries without isMeta are never dropped.
 */
export function shouldDropAsMeta(entry: TranscriptEntry): boolean {
  if (entry.isMeta !== true) return false;
  const text = firstTextContent(entry.message);
  if (text && META_KEEP_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return false;
  }
  return true;
}

/**
 * Strip tool_use, tool_result, and thinking blocks from transcript entries.
 * Keeps only text content blocks in message.content — the actual conversation.
 * Drops entries that become empty after stripping (e.g. pure tool_result entries).
 *
 * Handles both string and array content formats:
 * - String content: kept if non-empty after trimming
 * - Array content: filtered to only text blocks with non-empty text
 */
export function stripToolContent(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) out.push(entry);
      continue;
    }
    if (!Array.isArray(msg.content)) { out.push(entry); continue; }
    const textBlocks = msg.content.filter(
      (b) => b.type === 'text' && (b as { text?: string }).text?.trim(),
    );
    if (textBlocks.length === 0) continue;
    out.push({ ...entry, message: { ...msg, content: textBlocks } });
  }
  return out;
}
