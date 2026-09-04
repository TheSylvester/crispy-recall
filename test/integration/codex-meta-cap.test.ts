/**
 * Codex `session_meta` read cap (spec §5, deliverable 6).
 *
 * The reader used ONE fixed 8 KB buffer, so any rollout whose first line was
 * longer failed to parse: the whole meta went invisible, `git.repository_url`
 * with it, and subagent child rollouts leaked into the index as hot roots.
 * The read is now bounded read-to-first-newline (256 KB), decoded exactly once
 * so a multi-byte character on a chunk boundary survives.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit `env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }`; a child that inherits the parent env resolves
 * `recallRoot()` to the live `~/.recall` (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { extractCodexSessionMeta } from '../../src/adapters/codex/codex-jsonl-reader.js';
import { classifySession } from '../../src/recall/session-classifier.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb } from '../../src/db.js';

const PARENT = '22222222-3333-4444-5555-666666666666';
const CHILD = '11111111-2222-3333-4444-555555555555';

let dir: string;
let recallHome: string;
let restoreRoot: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

/** A session_meta line padded to at least `bytes` by growing the git object. */
function metaLine(payload: Record<string, unknown>, bytes: number): string {
  const line = () => JSON.stringify({ timestamp: '2026-09-04T00:00:00.000Z', type: 'session_meta', payload });
  let pad = 0;
  while (Buffer.byteLength(line()) < bytes) {
    pad += 1;
    (payload['git'] as Record<string, unknown>)['branch'] = 'b'.repeat(pad * 512);
  }
  return line();
}

function writeRollout(name: string, first: string, rest: string[] = []): string {
  const p = join(dir, name);
  writeFileSync(p, [first, ...rest].join('\n') + '\n');
  return p;
}

beforeEach(() => {
  // classifySession is NOT pure: lookupStoredProvenance opens getDb(dbPath()).
  // Without this block dbPath() resolves to the owner's live ~/.recall.
  recallHome = join(tmpdir(), `recall-metacap-${randomUUID()}`);
  dir = join(recallHome, 'rollouts');
  mkdirSync(dir, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['RECALL_HOME', 'RECALL_REMOTE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) prevEnv[k] = process.env[k];
  process.env['RECALL_HOME'] = recallHome;
  process.env['RECALL_REMOTE_ROOT'] = join(recallHome, 'remote');
  process.env['CLAUDE_CONFIG_DIR'] = join(recallHome, 'claude');
  process.env['CODEX_HOME'] = join(recallHome, 'codex');
  _resetDb();
});

afterEach(() => {
  restoreRoot?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(recallHome, { recursive: true, force: true });
});

describe('codex session_meta read cap', () => {
  it('is isolated: dbPath() points inside the temp root, never the live ~/.recall', () => {
    expect(resolve(dbPath()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(dbPath()).startsWith(resolve(recallHome))).toBe(true);
  });

  it('parses a ~40 KB session_meta and exposes git.repository_url', () => {
    const line = metaLine({
      id: PARENT,
      cwd: '/home/u/proj',
      git: { commit_hash: 'abc123', branch: 'main', repository_url: 'git@github.com:owner/repo.git' },
    }, 40 * 1024);
    expect(Buffer.byteLength(line)).toBeGreaterThan(40 * 1024);

    const meta = extractCodexSessionMeta(writeRollout(`rollout-2026-09-04T00-00-00-${PARENT}.jsonl`, line));
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe(PARENT);
    expect(meta!.git?.repository_url).toBe('git@github.com:owner/repo.git');
  });

  it('refuses a 300 KB first line (past the 256 KB bound) — returns null', () => {
    const line = metaLine({
      id: PARENT,
      cwd: '/home/u/proj',
      git: { commit_hash: 'abc123', branch: 'main', repository_url: 'git@github.com:owner/repo.git' },
    }, 300 * 1024);
    expect(Buffer.byteLength(line)).toBeGreaterThan(300 * 1024);

    expect(extractCodexSessionMeta(writeRollout(`rollout-2026-09-04T00-01-00-${PARENT}.jsonl`, line))).toBeNull();
  });

  it('classifies a subagent child with a 20 KB session_meta as agent via codex-meta', () => {
    const line = metaLine({
      id: CHILD,
      cwd: '/home/u/proj',
      git: { commit_hash: 'abc123', branch: 'main' },
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_type: 'worker' } } },
    }, 20 * 1024);
    const path = writeRollout(`rollout-2026-09-04T00-02-00-${CHILD}.jsonl`, line, [
      JSON.stringify({ timestamp: '2026-09-04T00:02:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child work' }] } }),
    ]);

    const c = classifySession({ sessionId: CHILD, transcriptPath: path, vendor: 'codex' });
    expect(c.kind).toBe('agent');
    expect(c.evidence).toBe('codex-meta');
    expect(c.parentSessionId).toBe(PARENT);
    expect(c.canonicalSessionId).toBe(CHILD);
  });

  it('a multi-byte character straddling the 8192-byte chunk boundary round-trips intact', () => {
    // Build the line so the 3-byte 日 spans byte 8191/8192 — a per-chunk decode
    // would replace it with U+FFFD. Both straddling alignments are covered.
    const build = (fillLen: number) => {
      const payload = {
        id: PARENT,
        cwd: `/tmp/${'a'.repeat(fillLen)}日本語/proj`,
        git: { commit_hash: 'abc123' },
      };
      return { payload, line: JSON.stringify({ timestamp: '2026-09-04T00:00:00.000Z', type: 'session_meta', payload }) };
    };
    const indexOfChar = (line: string) => Buffer.from(line).indexOf(Buffer.from('日'));

    for (const target of [8190, 8191]) {
      // Solve for the fill length that lands 日 at `target` (one byte per 'a').
      const probe = build(1000);
      const fillLen = 1000 + (target - indexOfChar(probe.line));
      const { payload, line } = build(fillLen);
      const at = indexOfChar(line);
      expect(at, 'fixture must straddle the chunk boundary').toBe(target);
      expect(at < 8192 && at + 3 > 8192, 'the character must cross byte 8192').toBe(true);

      const meta = extractCodexSessionMeta(
        writeRollout(`rollout-2026-09-04T00-04-0${target % 10}-${PARENT}.jsonl`, line),
      );
      expect(meta, `target ${target}`).not.toBeNull();
      expect(meta!.cwd, `target ${target}`).toBe(payload.cwd);
      expect(meta!.cwd.includes('\uFFFD'), `target ${target}`).toBe(false);
    }
  });
});
