/**
 * Session Manager Shim — minimal surface lifted recall code expects
 *
 * Three call-site needs documented in plan §4:
 *   - findSession      (legacy lookup; recall callers now pass paths directly)
 *   - loadSession      (legacy whole-session load; vendor readers preferred)
 *   - listAllSessions  (catchup enumeration; Phase 5 fills this in)
 *
 * Day 4 implementation: listAllSessions now globs the on-disk transcript roots
 * (CLAUDE_CONFIG_DIR / CODEX_HOME overrides honored) and tags each descriptor
 * with its vendor so the lifted catchup orchestrator can drive the 4-arg
 * ingestSessionMessages signature.
 *
 * @module session-manager-shim
 */

import { globSync } from 'glob';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptEntry } from './transcript.js';

/** Subset of the session descriptor that the lifted recall code reads. */
export interface ShimSessionInfo {
  sessionId: string;
  path: string;             // JSONL file path
  isSidechain: boolean;     // always false in standalone — no system sessions
  vendor: 'claude' | 'codex';
  projectPath?: string | null;
}

/**
 * Resolve a session ID to its on-disk descriptor.
 *
 * Phase 3 will glob ~/.claude/projects/**\/*.jsonl and ~/.codex/sessions/...
 * Day 1 returns undefined.
 */
export function findSession(_sessionId: string): ShimSessionInfo | undefined {
  return undefined;
}

/**
 * Load a session's transcript entries.
 *
 * Phase 3 will dispatch on /.claude/ vs /.codex/ path prefix.
 * Day 1 returns an empty array — the CLI's Day 1 surface (search / list)
 * does not invoke this path.
 */
export async function loadSession(_sessionId: string): Promise<TranscriptEntry[]> {
  return [];
}

/**
 * Enumerate every session known to the standalone.
 *
 * Globs the Claude + Codex transcript roots (honoring CLAUDE_CONFIG_DIR /
 * CODEX_HOME env overrides) and derives sessionId from the filename.
 */
export function listAllSessions(opts?: { vendors?: ('claude' | 'codex')[] }): ShimSessionInfo[] {
  const vendors = opts?.vendors ?? ['claude', 'codex'];
  const claudeRoot = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  const codexRoot = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');

  const out: ShimSessionInfo[] = [];

  if (vendors.includes('claude')) {
    const files = globSync(join(claudeRoot, 'projects', '**', '*.jsonl'), { nodir: true });
    for (const file of files) {
      out.push({
        sessionId: sessionIdFromPath(file, 'claude'),
        path: file,
        isSidechain: false,
        vendor: 'claude',
      });
    }
  }
  if (vendors.includes('codex')) {
    const files = globSync(join(codexRoot, 'sessions', '**', '*.jsonl'), { nodir: true });
    for (const file of files) {
      out.push({
        sessionId: sessionIdFromPath(file, 'codex'),
        path: file,
        isSidechain: false,
        vendor: 'codex',
      });
    }
  }

  return out;
}

function sessionIdFromPath(file: string, vendor: 'claude' | 'codex'): string {
  // Claude: ~/.claude/projects/<encoded>/<session-uuid>.jsonl  → basename minus .jsonl
  // Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl → trailing uuid
  const base = file.split('/').pop()!.replace(/\.jsonl$/, '');
  if (vendor === 'claude') return base;
  const m = base.match(/^rollout-.+-([0-9a-f-]{36})$/i);
  return m ? m[1] : base;
}
