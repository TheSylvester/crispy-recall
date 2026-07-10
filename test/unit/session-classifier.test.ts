/**
 * §8.1 Classification and provenance — classifier fixtures for both vendors.
 *
 * classifySession is evidence-based: stored provenance, hook fields, Claude
 * path layout/naming, and Codex session_meta.source.subagent.thread_spawn.
 * These tests cover every §8.1 case that is decidable without a live ingest
 * (the ingest-level identity reconciliation lives in agent-cold.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { classifySession } from '../../src/recall/session-classifier.js';
import {
  extractCodexSessionMeta, findCodexSessionFile, scanCodexSessionFiles,
} from '../../src/adapters/codex/codex-jsonl-reader.js';

const PARENT_UUID = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const CHILD_UUID = '11111111-2222-3333-4444-555555555555';

let recallHome: string;
let restoreRoot: (() => void) | undefined;
let prevCodexHome: string | undefined;

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-classify-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  prevCodexHome = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = join(recallHome, 'codex-home');
  _resetDb();
  getDb(dbPath()); // fresh new-generation schema (provenance tables exist)
});

afterEach(() => {
  restoreRoot?.();
  _resetDb();
  if (prevCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = prevCodexHome;
  rmSync(recallHome, { recursive: true, force: true });
});

function writeCodexRollout(
  relPath: string,
  sessionMetaPayload: Record<string, unknown>,
): string {
  const p = join(process.env['CODEX_HOME']!, 'sessions', relPath);
  mkdirSync(join(p, '..'), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: sessionMetaPayload }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello from codex' }] },
    }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('classifySession — Claude', () => {
  it('top-level transcript → root/hot', () => {
    const c = classifySession({
      sessionId: PARENT_UUID,
      transcriptPath: `/home/u/.claude/projects/proj/${PARENT_UUID}.jsonl`,
      vendor: 'claude',
    });
    expect(c.kind).toBe('root');
    expect(c.canonicalSessionId).toBe(PARENT_UUID);
    expect(c.parentSessionId).toBeNull();
  });

  it('<parent>/subagents/agent-*.jsonl → agent with exact leaf id and parent', () => {
    const c = classifySession({
      sessionId: 'agent-feedbeef',
      transcriptPath: `/home/u/.claude/projects/proj/${PARENT_UUID}/subagents/agent-feedbeef.jsonl`,
      vendor: 'claude',
    });
    expect(c.kind).toBe('agent');
    expect(c.canonicalSessionId).toBe('agent-feedbeef');
    expect(c.parentSessionId).toBe(PARENT_UUID);
    expect(c.evidence).toBe('claude-path');
  });

  it('Windows separators classify identically', () => {
    const c = classifySession({
      sessionId: 'agent-feedbeef',
      transcriptPath: `C:\\Users\\u\\.claude\\projects\\proj\\${PARENT_UUID}\\subagents\\agent-feedbeef.jsonl`,
      vendor: 'claude',
    });
    expect(c.kind).toBe('agent');
    expect(c.canonicalSessionId).toBe('agent-feedbeef');
    expect(c.parentSessionId).toBe(PARENT_UUID);
  });

  it('agent-* basename without the subagents layout is still a leaf (name evidence)', () => {
    const c = classifySession({
      sessionId: 'agent-cafe0123',
      transcriptPath: '/somewhere/else/agent-cafe0123.jsonl',
      vendor: 'claude',
    });
    expect(c.kind).toBe('agent');
    expect(c.evidence).toBe('claude-name');
  });
});

describe('classifySession — Codex', () => {
  it('normal session_meta.source → root/hot, canonical = session-meta id', () => {
    const p = writeCodexRollout(
      `2026/01/01/rollout-2026-01-01T00-00-00-${PARENT_UUID}.jsonl`,
      { id: PARENT_UUID, cwd: '/proj', source: { type: 'user' } },
    );
    const c = classifySession({ sessionId: PARENT_UUID, transcriptPath: p, vendor: 'codex' });
    expect(c.kind).toBe('root');
    expect(c.canonicalSessionId).toBe(PARENT_UUID);
  });

  it('source.subagent.thread_spawn → agent with child UUID, parent thread, depth, agent metadata', () => {
    const p = writeCodexRollout(
      `2026/01/01/rollout-2026-01-01T00-00-00-${CHILD_UUID}.jsonl`,
      {
        id: CHILD_UUID, cwd: '/proj',
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT_UUID, depth: 1, agent_type: 'explorer', agent_path: 'agents/explorer.md' } } },
      },
    );
    const c = classifySession({ sessionId: CHILD_UUID, transcriptPath: p, vendor: 'codex' });
    expect(c.kind).toBe('agent');
    expect(c.canonicalSessionId).toBe(CHILD_UUID);
    expect(c.parentSessionId).toBe(PARENT_UUID);
    expect(c.agentDepth).toBe(1);
    expect(c.agentMeta).toMatchObject({ agent_type: 'explorer', agent_path: 'agents/explorer.md' });
    expect(c.evidence).toBe('codex-meta');
  });

  it('nested children (depth 2) remain cold', () => {
    const nested = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const p = writeCodexRollout(
      `2026/01/02/rollout-2026-01-02T00-00-00-${nested}.jsonl`,
      { id: nested, cwd: '/proj', source: { subagent: { thread_spawn: { parent_thread_id: CHILD_UUID, depth: 2 } } } },
    );
    const c = classifySession({ sessionId: nested, transcriptPath: p, vendor: 'codex' });
    expect(c.kind).toBe('agent');
    expect(c.agentDepth).toBe(2);
    expect(c.parentSessionId).toBe(CHILD_UUID);
  });

  it('malformed subagent provenance is conservative: stays root/hot (never guessed cold)', () => {
    const p = writeCodexRollout(
      `2026/01/03/rollout-2026-01-03T00-00-00-${PARENT_UUID}.jsonl`,
      { id: PARENT_UUID, cwd: '/proj', source: { subagent: 'yes-but-a-string' } },
    );
    const c = classifySession({ sessionId: PARENT_UUID, transcriptPath: p, vendor: 'codex' });
    expect(c.kind).toBe('root');
  });

  it('hook evidence: agent_id becomes an alias, canonical is the session-meta UUID', () => {
    const p = writeCodexRollout(
      `2026/01/04/rollout-2026-01-04T00-00-00-${CHILD_UUID}.jsonl`,
      { id: CHILD_UUID, cwd: '/proj', source: { subagent: { thread_spawn: { parent_thread_id: PARENT_UUID, depth: 1 } } } },
    );
    const c = classifySession({
      sessionId: 'agent-a1b2c3',
      transcriptPath: p,
      vendor: 'codex',
      hook: { payloadSessionId: PARENT_UUID, agentId: 'agent-a1b2c3', isSubagent: true },
    });
    expect(c.kind).toBe('agent');
    expect(c.canonicalSessionId).toBe(CHILD_UUID);
    expect(c.aliases).toContain('agent-a1b2c3');
  });

  it('a hook-declared child with NO derivable identity is unresolvable (skip, never parent-stapled)', () => {
    const p = join(recallHome, 'oddly-named.jsonl');
    writeFileSync(p, ''); // empty file — no session_meta, no rollout-uuid name
    const c = classifySession({
      sessionId: 'oddly-named',
      transcriptPath: p,
      vendor: 'codex',
      hook: { payloadSessionId: PARENT_UUID, isSubagent: true },
    });
    expect(c.unresolvable).toBe(true);
    expect(c.canonicalSessionId).not.toBe(PARENT_UUID);
  });

  it('stored provenance wins on a later scan (one canonical identity per path)', () => {
    const p = writeCodexRollout(
      `2026/01/05/rollout-2026-01-05T00-00-00-${CHILD_UUID}.jsonl`,
      { id: CHILD_UUID, cwd: '/proj' },
    );
    getDb(dbPath()).run(
      `INSERT INTO session_provenance (session_id, vendor, kind, parent_session_id, updated_at, transcript_path)
       VALUES (?, 'codex', 'agent', ?, 0, ?)`,
      [CHILD_UUID, PARENT_UUID, p.replace(/\\/g, '/')],
    );
    const c = classifySession({ sessionId: CHILD_UUID, transcriptPath: p, vendor: 'codex' });
    expect(c.evidence).toBe('stored');
    expect(c.kind).toBe('agent');
    expect(c.parentSessionId).toBe(PARENT_UUID);
  });
});

describe('codex reader honors CODEX_HOME (no hardcoded ~/.codex)', () => {
  it('extractCodexSessionMeta surfaces payload.source; find/scan use the override root', () => {
    const p = writeCodexRollout(
      `2026/02/01/rollout-2026-02-01T00-00-00-${CHILD_UUID}.jsonl`,
      { id: CHILD_UUID, cwd: '/proj', source: { subagent: { thread_spawn: { parent_thread_id: PARENT_UUID, depth: 1 } } } },
    );
    const meta = extractCodexSessionMeta(p);
    expect(meta?.id).toBe(CHILD_UUID);
    expect(meta?.source).toBeDefined();

    // Both walkers resolve inside the sandboxed CODEX_HOME (which contains
    // exactly one session) — a hardcoded ~/.codex would find none of this.
    expect(findCodexSessionFile(CHILD_UUID)).toBe(p);
    const scanned = scanCodexSessionFiles();
    expect(scanned).toHaveLength(1);
    expect(scanned[0]!.sessionId).toBe(CHILD_UUID);
  });
});
