/**
 * `skill/SKILL.md.template` — the satellite wording deltas (spec §7).
 *
 * The template was size-tuned by a 40-run benchmark, so this suite pins the
 * three edited phrases, the `$RECALL_BIN` placeholder, the byte budget and the
 * benchmark-tuned YAML front matter against drift.
 *
 * Isolation — in-process: every new suite that calls `runInstall`, `runDoctor`,
 * `getStatus`, `runUninstall` or `runPreflight` IN-PROCESS MUST first call
 * `restore = _setTestRoot(join(<tmp>, '.recall'))` (restore it in
 * afterAll/afterEach) AND set `process.env.CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
 * `RECALL_REMOTE_ROOT` to temp dirs (restoring the previous values), exactly as
 * test/unit/preflight-node-version.test.ts:25-38 and
 * test/integration/manifest-optout.test.ts:33-54 do; without it `recallRoot()`
 * resolves to the owner's LIVE `~/.recall` (paths.ts:33-40).
 * Isolation — spawned children: `_setTestRoot` does not cross a process
 * boundary: every new suite that spawns a child (hub daemon, `dist/recall.js`,
 * `stop-hook.js`, `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const TEMPLATE = readFileSync(join(ROOT, 'skill', 'SKILL.md.template'), 'utf8');

/** Lines 1-13 of the committed template at bc07366, byte for byte. */
const FRONT_MATTER = [
  '---',
  'name: recall',
  'description: >-',
  '  USE PROACTIVELY to load relevant past session context before non-trivial',
  '  tasks, architectural decisions, or any implementation with likely prior',
  '  history. Also use when the user says "recall", "remember", "what did we',
  '  do", "find that session", "what was I working on", or references past',
  '  conversations.',
  'when_to_use: >-',
  '  Trigger for phrases like "remind me about", "pick up where we left off",',
  '  "continue from last time", or when starting complex work in an area with',
  '  obvious prior sessions. Skip for simple lookups and trivial questions.',
  '---',
].join('\n');

describe('skill/SKILL.md.template', () => {
  it('keeps the benchmark-tuned YAML front matter byte-identical', () => {
    expect(TEMPLATE.split('\n').slice(0, 13).join('\n')).toBe(FRONT_MATTER);
  });

  it('keeps the $RECALL_BIN placeholder the installer substitutes', () => {
    expect(TEMPLATE).toContain('$RECALL_BIN');
  });

  it('states the three satellite deltas', () => {
    expect(TEMPLATE).toContain('Search is scoped to this repo (any clone or worktree)');
    expect(TEMPLATE).toContain('(local sessions only on a satellite).');
    expect(TEMPLATE).toContain('on a\n  satellite, after the push lands (seconds).');
  });

  it('stays inside the size budget the skill benchmark set', () => {
    expect(Buffer.byteLength(TEMPLATE, 'utf8')).toBeLessThanOrEqual(2500);
    expect(TEMPLATE.split('\n')).toHaveLength(45); // 44 lines + trailing newline
  });
});
