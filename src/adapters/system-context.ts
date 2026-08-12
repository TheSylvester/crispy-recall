/**
 * System-Context Detection — shared across vendor adapters
 *
 * Content-based heuristic for detecting SDK-injected system context.
 *
 * Claude Code injects system context (AGENTS.md, CLAUDE.md, environment
 * context, system-reminders) as `type: "user"` entries in the JSONL. Newer
 * SDK versions flag these with `isMeta: true`, but older versions (≤ 2.1.58)
 * do not. Codex rollouts open every session with the same AGENTS.md /
 * `<INSTRUCTIONS>` / `<environment_context>` preambles as plain user
 * messages and never carry an explicit flag. This heuristic detects both by
 * content prefix so downstream filters can hide them from the UI, exclude
 * them from cross-vendor history serialization, and drop them at ingest.
 *
 * Patterns detected:
 * - `<system-reminder>` — SDK-injected reminders (skills, tools, context)
 * - `<environment_context>` — cwd, shell, OS context
 * - `<INSTRUCTIONS>` — AGENTS.md / skill instructions (Codex format)
 * - `# AGENTS.md instructions for` — Codex AGENTS.md header
 * - `<context>` at line start — Claude system context blocks
 * - `<task-notification>` — background agent completion notifications
 * - `<command-name>` — slash command invocations
 * - `<local-command-stdout>` — slash command output
 * - `<local-command-caveat>` — slash command caveats/warnings
 *
 * @module adapters/system-context
 */

import type { TranscriptMessage } from '../transcript.js';

/** Extract the first text content of a message: string content as-is, or
 *  the first text block of array content. */
export function firstTextContent(
  message: TranscriptMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Check the first text block — system context is always the first (or only) block
    const firstText = content.find(
      (b) => typeof b === 'object' && b !== null && b.type === 'text',
    );
    if (firstText && 'text' in firstText) {
      return (firstText as { text: string }).text;
    }
  }
  return undefined;
}

/** True when a user message's first text content matches a known
 *  system-context prefix. Returns false for non-user roles by design. */
export function isSystemContextContent(message: TranscriptMessage | undefined): boolean {
  if (!message || message.role !== 'user') return false;

  const text = firstTextContent(message);
  if (!text) return false;

  // Fast prefix checks (most common patterns)
  if (text.startsWith('<system-reminder>')) return true;
  if (text.startsWith('<environment_context>')) return true;
  if (text.startsWith('<INSTRUCTIONS>')) return true;
  if (text.startsWith('# AGENTS.md instructions for')) return true;
  if (text.startsWith('<context>')) return true;

  // Claude Code system-injected user messages — background task notifications,
  // slash command invocations and their output. These are internal plumbing
  // written as type: 'user' entries without isMeta in the JSONL.
  if (text.startsWith('<task-notification>')) return true;
  if (text.startsWith('<command-name>')) return true;
  if (text.startsWith('<local-command-stdout>')) return true;
  if (text.startsWith('<local-command-caveat>')) return true;

  return false;
}
