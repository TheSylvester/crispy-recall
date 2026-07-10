/**
 * §8.2 Retrieval/cold behavior — agent leaves are durable and explicitly
 * readable but excluded from EVERY default retrieval and embedding path.
 *
 * Covers, for both vendors:
 *   - parent narration in normal FTS + semantic results
 *   - child-only tokens produce no default hit (FTS, list, grep, gap counts)
 *   - child rows remain explicitly readable by session/message id
 *   - the hot-only vector WRITE guard (a drain cannot vector a cold row)
 *   - SubagentStop does not spawn embed-pending (built stop-hook bundle)
 *   - repeated ingests are idempotent
 *   - Codex copied parent history inside a child rollout stays cold
 *   - SubagentStop → T1 mtime-scan resolves ONE canonical Codex child even
 *     when the hook agent_id differs from the rollout UUID
 *   - hook evidence reclassifies an earlier hot ingest cold and purges its
 *     vector (the SubagentStop-after-T1 window)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { _setTestRoot, dbPath, binDir } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import {
  searchMessagesFts, readSessionMessages, getMessageByUuid, grepMessages,
  getEmbeddingGapStats, getSessionsWithEmbeddingGap, getUnembeddedMessages,
  insertMessageVectors, searchMessagesSemantic, getEmbedVersionStats,
} from '../../src/recall/message-store.js';
import { listSessions } from '../../src/recall/memory-queries.js';
import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { quantizeToQ8, computeNorm } from '../../src/recall/quantize.js';

const ROOT = join(__dirname, '..', '..');
const HOOK_BUNDLE = join(ROOT, 'dist', 'stop-hook.js');

const CLAUDE_PARENT = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const CLAUDE_CHILD = 'agent-feedbeef';
const CODEX_PARENT = '22222222-3333-4444-5555-666666666666';
const CODEX_CHILD = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';

// Unique searchable tokens (≥50-char texts so embedding-gap eligibility applies).
const PAD = ' — deliberately padded to clear the fifty character embedding floor.';
const PARENT_TOKEN_CLAUDE = 'zanzibarparent';
const CHILD_TOKEN_CLAUDE = 'quixoticchild';
const PARENT_TOKEN_CODEX = 'nebulaparent';
const CHILD_TOKEN_CODEX = 'krakenchild';
const COPIED_TOKEN = 'xylophonecopied';

let recallHome: string;
let claudeRoot: string;
let codexHome: string;
let restoreRoot: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

function claudeLine(sessionId: string, i: number, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: role,
    uuid: `${sessionId}-msg-${i}`,
    parentUuid: i === 0 ? null : `${sessionId}-msg-${i - 1}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    cwd: '/proj',
    message: { role, content: text },
  });
}

function writeClaudeParent(): string {
  const dir = join(claudeRoot, 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${CLAUDE_PARENT}.jsonl`);
  writeFileSync(p, [
    claudeLine(CLAUDE_PARENT, 0, 'user', `please investigate the ${COPIED_TOKEN} subsystem${PAD}`),
    claudeLine(CLAUDE_PARENT, 1, 'assistant', `parent narration: the ${PARENT_TOKEN_CLAUDE} approach won${PAD}`),
  ].join('\n') + '\n');
  return p;
}

function writeClaudeChild(): string {
  const dir = join(claudeRoot, 'projects', 'proj', CLAUDE_PARENT, 'subagents');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${CLAUDE_CHILD}.jsonl`);
  writeFileSync(p, [
    claudeLine(CLAUDE_CHILD, 0, 'user', `explore the ${CHILD_TOKEN_CLAUDE} area in detail${PAD}`),
    claudeLine(CLAUDE_CHILD, 1, 'assistant', `leaf progress narration about ${CHILD_TOKEN_CLAUDE}${PAD}`),
    claudeLine(CLAUDE_CHILD, 2, 'assistant', `leaf FINAL answer mentioning ${CHILD_TOKEN_CLAUDE}${PAD}`),
  ].join('\n') + '\n');
  return p;
}

function codexEnvelope(type: string, payload: Record<string, unknown>, s = 0): string {
  return JSON.stringify({ timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, s)).toISOString(), type, payload });
}

function codexUser(text: string, s: number): string {
  return codexEnvelope('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, s);
}

function codexAssistant(text: string, s: number): string {
  return codexEnvelope('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, s);
}

function writeCodexParent(): string {
  const dir = join(codexHome, 'sessions', '2026', '01', '02');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-01-02T00-00-00-${CODEX_PARENT}.jsonl`);
  writeFileSync(p, [
    codexEnvelope('session_meta', { id: CODEX_PARENT, cwd: '/proj' }),
    codexUser(`kick off the ${COPIED_TOKEN} analysis${PAD}`, 1),
    codexAssistant(`parent codex narration: ${PARENT_TOKEN_CODEX} conclusion${PAD}`, 2),
  ].join('\n') + '\n');
  return p;
}

function writeCodexChild(): string {
  const dir = join(codexHome, 'sessions', '2026', '01', '02');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-01-02T00-01-00-${CODEX_CHILD}.jsonl`);
  writeFileSync(p, [
    codexEnvelope('session_meta', {
      id: CODEX_CHILD, cwd: '/proj',
      source: { subagent: { thread_spawn: { parent_thread_id: CODEX_PARENT, depth: 1, agent_type: 'worker' } } },
    }),
    // COPIED parent history inside the child rollout (fork semantics).
    codexUser(`kick off the ${COPIED_TOKEN} analysis${PAD}`, 1),
    codexAssistant(`child codex progress: ${CHILD_TOKEN_CODEX} detail one${PAD}`, 2),
    codexAssistant(`child codex FINAL: ${CHILD_TOKEN_CODEX} answer${PAD}`, 3),
  ].join('\n') + '\n');
  return p;
}

async function ingestAll(): Promise<void> {
  expect((await ingestSessionMessages(CLAUDE_PARENT, writeClaudeParent(), 'claude')).error).toBeUndefined();
  expect((await ingestSessionMessages(CLAUDE_CHILD, writeClaudeChild(), 'claude')).error).toBeUndefined();
  expect((await ingestSessionMessages(CODEX_PARENT, writeCodexParent(), 'codex')).error).toBeUndefined();
  expect((await ingestSessionMessages(CODEX_CHILD, writeCodexChild(), 'codex')).error).toBeUndefined();
}

function countRows(sql: string, params: unknown[] = []): number {
  return (getDb(dbPath()).get(sql, params) as { c: number }).c;
}

beforeEach(() => {
  recallHome = join(tmpdir(), `recall-cold-${randomUUID()}`);
  claudeRoot = join(recallHome, 'claude-fake');
  codexHome = join(recallHome, 'codex-fake');
  mkdirSync(join(claudeRoot, 'projects'), { recursive: true });
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_HOME']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = claudeRoot;
  process.env['CODEX_HOME'] = codexHome;
  _resetDb();
  getDb(dbPath());
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

describe('agent leaves are cold but durable (both vendors)', () => {
  it('parent narration hits default FTS; child-only tokens do not', async () => {
    await ingestAll();
    expect(searchMessagesFts(PARENT_TOKEN_CLAUDE).length).toBeGreaterThan(0);
    expect(searchMessagesFts(PARENT_TOKEN_CODEX).length).toBeGreaterThan(0);
    expect(searchMessagesFts(CHILD_TOKEN_CLAUDE)).toHaveLength(0);
    expect(searchMessagesFts(CHILD_TOKEN_CODEX)).toHaveLength(0);
  }, 30_000);

  it('copied parent history inside a Codex child rollout is never a hot child hit', async () => {
    await ingestAll();
    const hits = searchMessagesFts(COPIED_TOKEN);
    expect(hits.length).toBeGreaterThan(0);
    const sessions = new Set(hits.map((h) => h.session_id));
    expect(sessions.has(CODEX_CHILD)).toBe(false);
    expect(sessions.has(CLAUDE_CHILD)).toBe(false);
  }, 30_000);

  it('child messages remain explicitly readable by session and message id', async () => {
    await ingestAll();
    for (const child of [CLAUDE_CHILD, CODEX_CHILD]) {
      const page = readSessionMessages(child, 0, 10);
      expect(page, child).not.toBeNull();
      expect(page!.messages.length).toBeGreaterThanOrEqual(2);
      const first = page!.messages[0]!;
      expect(getMessageByUuid(child, first.message_id)?.message_text).toBe(first.text);
    }
    // Full leaf text preserved, including the final.
    const claudePage = readSessionMessages(CLAUDE_CHILD, 0, 10)!;
    expect(claudePage.messages.some((m) => m.text.includes('FINAL answer'))).toBe(true);
  }, 30_000);

  it('no child vector exists; child rows appear in NO embedding-gap selector', async () => {
    await ingestAll();
    // Gap counts: only the 4 hot (parent) rows are eligible.
    const stats = getEmbeddingGapStats();
    expect(stats.totalMessages).toBe(4);
    expect(stats.gapCount).toBe(4);
    const gapSessions = getSessionsWithEmbeddingGap();
    expect(gapSessions).not.toContain(CLAUDE_CHILD);
    expect(gapSessions).not.toContain(CODEX_CHILD);
    const unembedded = getUnembeddedMessages(100);
    expect(unembedded.some((m) => m.session_id === CLAUDE_CHILD || m.session_id === CODEX_CHILD)).toBe(false);
    expect(countRows('SELECT COUNT(*) AS c FROM message_vectors')).toBe(0);
  }, 30_000);

  it('the vector WRITE is hot-guarded: a drain cannot land a vector on a cold row', async () => {
    await ingestAll();
    const childMsg = getDb(dbPath()).get(
      `SELECT message_id FROM messages WHERE session_id = ? LIMIT 1`, [CLAUDE_CHILD],
    ) as { message_id: string };
    const f32 = new Float32Array(768).fill(0.1);
    const { q8, scale } = quantizeToQ8(f32);
    insertMessageVectors([{ messageId: childMsg.message_id, embeddingQ8: q8, norm: computeNorm(f32), quantScale: scale }]);
    expect(countRows('SELECT COUNT(*) AS c FROM message_vectors')).toBe(0);

    // …while a hot row takes the same write fine.
    const parentMsg = getDb(dbPath()).get(
      `SELECT message_id FROM messages WHERE session_id = ? LIMIT 1`, [CLAUDE_PARENT],
    ) as { message_id: string };
    insertMessageVectors([{ messageId: parentMsg.message_id, embeddingQ8: q8, norm: computeNorm(f32), quantScale: scale }]);
    expect(countRows('SELECT COUNT(*) AS c FROM message_vectors')).toBe(1);
  }, 30_000);

  it('semantic search returns hot rows only (and coverage counts hot only)', async () => {
    await ingestAll();
    const f32 = new Float32Array(768).fill(0.25);
    const { q8, scale } = quantizeToQ8(f32);
    const norm = computeNorm(f32);
    const parentMsg = getDb(dbPath()).get(
      `SELECT message_id FROM messages WHERE session_id = ? ORDER BY message_seq DESC LIMIT 1`, [CODEX_PARENT],
    ) as { message_id: string };
    insertMessageVectors([{ messageId: parentMsg.message_id, embeddingQ8: q8, norm, quantScale: scale }]);

    const hits = searchMessagesSemantic(q8, norm, scale, { limit: 10 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.session_id).toBe(CODEX_PARENT);
    expect(getEmbedVersionStats().total).toBe(1);
  }, 30_000);

  it('normal list and default grep exclude children; session-scoped grep reads them', async () => {
    await ingestAll();
    const listed = listSessions(dbPath(), 100).map((s) => s.session_id);
    expect(listed).toContain(CLAUDE_PARENT);
    expect(listed).toContain(CODEX_PARENT);
    expect(listed).not.toContain(CLAUDE_CHILD);
    expect(listed).not.toContain(CODEX_CHILD);

    expect(grepMessages(CHILD_TOKEN_CLAUDE, 10)).toHaveLength(0);
    expect(grepMessages(CHILD_TOKEN_CODEX, 10)).toHaveLength(0);
    // Explicit session-scoped inspection still reaches the leaf text.
    expect(grepMessages(CHILD_TOKEN_CLAUDE, 10, CLAUDE_CHILD).length).toBeGreaterThan(0);
  }, 30_000);

  it('repeated ingests are idempotent (both classes)', async () => {
    await ingestAll();
    const before = {
      total: countRows('SELECT COUNT(*) AS c FROM messages'),
      agent: countRows(`SELECT COUNT(*) AS c FROM messages WHERE retrieval_class = 'agent'`),
    };
    await ingestAll(); // second pass
    expect(countRows('SELECT COUNT(*) AS c FROM messages')).toBe(before.total);
    expect(countRows(`SELECT COUNT(*) AS c FROM messages WHERE retrieval_class = 'agent'`)).toBe(before.agent);
  }, 30_000);

  it('hook evidence reclassifies an earlier hot ingest cold and purges its vector', async () => {
    // A Codex child whose session_meta carries NO subagent info — a T1 scan
    // ingests it hot…
    const dir = join(codexHome, 'sessions', '2026', '01', '03');
    mkdirSync(dir, { recursive: true });
    const orphan = 'cccccccc-dddd-eeee-ffff-000000000000';
    const p = join(dir, `rollout-2026-01-03T00-00-00-${orphan}.jsonl`);
    writeFileSync(p, [
      codexEnvelope('session_meta', { id: orphan, cwd: '/proj' }),
      codexAssistant(`ambiguous child content with sphinxtoken${PAD}`, 1),
    ].join('\n') + '\n');

    const first = await ingestSessionMessages(orphan, p, 'codex');
    expect(first.retrievalClass).toBe('hot');
    const msg = getDb(dbPath()).get(
      `SELECT message_id FROM messages WHERE session_id = ?`, [orphan],
    ) as { message_id: string };
    const f32 = new Float32Array(768).fill(0.5);
    const { q8, scale } = quantizeToQ8(f32);
    insertMessageVectors([{ messageId: msg.message_id, embeddingQ8: q8, norm: computeNorm(f32), quantScale: scale }]);
    expect(countRows('SELECT COUNT(*) AS c FROM message_vectors')).toBe(1);

    // …then a SubagentStop arrives with explicit child evidence.
    const second = await ingestSessionMessages(orphan, p, 'codex', {
      hook: { payloadSessionId: CODEX_PARENT, agentId: 'agent-late', isSubagent: true },
    });
    expect(second.retrievalClass).toBe('agent');
    expect(countRows(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND retrieval_class = 'agent'`, [orphan]))
      .toBeGreaterThan(0);
    expect(countRows('SELECT COUNT(*) AS c FROM message_vectors')).toBe(0); // purged
    expect(searchMessagesFts('sphinxtoken')).toHaveLength(0); // out of the index
  }, 30_000);

  it('SubagentStop → T1 mtime-scan: ONE canonical Codex child even when hook agent_id differs', async () => {
    const childPath = writeCodexChild();
    writeCodexParent();

    // 1. SubagentStop-style ingest with a hook agent_id ≠ rollout UUID.
    const res = await ingestSessionMessages('agent-deadbeef', childPath, 'codex', {
      hook: { payloadSessionId: CODEX_PARENT, agentId: 'agent-deadbeef', isSubagent: true },
    });
    expect(res.sessionId).toBe(CODEX_CHILD);

    // 2. T1 mtime-scan over the same path (no hook context).
    const scan = await mtimeScan({ vendors: ['codex'] });
    expect(scan.failed).toBe(0);

    // ONE canonical identity: no rows under the hook id, no duplicates.
    expect(countRows('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?', ['agent-deadbeef'])).toBe(0);
    const childRows = countRows('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?', [CODEX_CHILD]);
    expect(childRows).toBe(3); // copied user turn + two assistant turns, once each
    // The alias resolves for explicit reads.
    const alias = getDb(dbPath()).get(
      'SELECT session_id FROM session_aliases WHERE alias_id = ?', ['agent-deadbeef'],
    ) as { session_id: string } | undefined;
    expect(alias?.session_id).toBe(CODEX_CHILD);
    // Provenance is durable: parent id, kind, path mapping.
    const prov = getDb(dbPath()).get(
      'SELECT kind, parent_session_id FROM session_provenance WHERE session_id = ?', [CODEX_CHILD],
    ) as { kind: string; parent_session_id: string };
    expect(prov.kind).toBe('agent');
    expect(prov.parent_session_id).toBe(CODEX_PARENT);
  }, 30_000);
});

describe('stop-hook bundle: SubagentStop never spawns embed-pending', () => {
  function stageMarkerEmbedPending(): string {
    mkdirSync(binDir(), { recursive: true });
    const marker = join(recallHome, 'embed-pending-ran');
    writeFileSync(join(binDir(), 'embed-pending.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n`);
    return marker;
  }

  function runHook(payload: Record<string, unknown>): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK_BUNDLE], {
        env: {
          ...process.env,
          RECALL_HOME: recallHome,
          CLAUDE_CONFIG_DIR: claudeRoot,
          CODEX_HOME: codexHome,
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
      child.on('close', (code) => resolve(code));
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('Stop (parent) exits 0 and spawns embed-pending; SubagentStop exits 0 and does NOT', async () => {
    if (!existsSync(HOOK_BUNDLE)) throw new Error('dist/stop-hook.js missing — run `npm run build` first');
    const marker = stageMarkerEmbedPending();
    const parentPath = writeClaudeParent();
    const childPath = writeClaudeChild();

    // SubagentStop first: no marker may appear.
    const subCode = await runHook({
      session_id: CLAUDE_PARENT,
      transcript_path: parentPath,
      agent_id: CLAUDE_CHILD,
      agent_transcript_path: childPath,
      cwd: '/proj',
      hook_event_name: 'SubagentStop',
    });
    expect(subCode).toBe(0);
    await sleep(700); // grace for a (wrong) detached spawn to land
    expect(existsSync(marker), 'SubagentStop must not spawn embed-pending').toBe(false);

    // The child ingested cold and readable.
    _resetDb();
    expect(countRows(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND retrieval_class = 'agent'`, [CLAUDE_CHILD]))
      .toBe(3);

    // Stop (parent): marker appears.
    const stopCode = await runHook({
      session_id: CLAUDE_PARENT,
      transcript_path: parentPath,
      cwd: '/proj',
      hook_event_name: 'Stop',
    });
    expect(stopCode).toBe(0);
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await sleep(50);
    expect(existsSync(marker), 'Stop should spawn embed-pending').toBe(true);
  }, 30_000);
});
