import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { runPurgeMeta, countMetaResidue, type PurgeMetaSummary } from '../../src/recall/purge-meta.js';
import { loadTranscriptEntries, extractEntryText } from '../../src/recall/message-ingest.js';
import { insertMessages, type MessageRecord, type SessionProvenanceRecord } from '../../src/recall/message-store.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

// ============================================================================
// Fixture — a pre-filter DB: boilerplate rows inserted DIRECTLY (bypassing the
// Phase 1 ingest filter), plus real dialogue, a whitelisted task notification,
// an orphan session (transcript gone), and a no-path provenance row.
// ============================================================================

const SID_CLAUDE = randomUUID();
const SID_CODEX = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const SID_ORPHAN = randomUUID();
const SID_NOPATH = randomUUID();

let recallHome: string;
let restoreRoot: () => void;

function d() {
  return getDb(dbPath());
}

function provenance(
  sessionId: string,
  vendor: 'claude' | 'codex',
  transcriptPath: string | null,
): SessionProvenanceRecord {
  return {
    sessionId, vendor, kind: 'root',
    parentSessionId: null, agentDepth: null, agentMeta: null, transcriptPath,
  };
}

function insertVector(messageId: string): void {
  d().run(
    `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale, embed_version)
     VALUES (?, ?, ?, ?, 3)`,
    [messageId, Buffer.alloc(8), 1.0, 0.1],
  );
}

function rowIds(sessionId: string): string[] {
  return (d().all(
    'SELECT message_id FROM messages WHERE session_id = ? ORDER BY message_seq',
    [sessionId],
  ) as Array<{ message_id: string }>).map((r) => r.message_id);
}

function vectorCount(messageId: string): number {
  const row = d().get(
    'SELECT COUNT(*) AS n FROM message_vectors WHERE message_id = ?',
    [messageId],
  ) as { n: number };
  return Number(row.n);
}

function ftsHits(term: string): number {
  const row = d().get(
    `SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`,
    [term],
  ) as { n: number };
  return Number(row.n);
}

function totalRows(): number {
  return Number((d().get('SELECT COUNT(*) AS n FROM messages') as { n: number }).n);
}

beforeAll(() => {
  recallHome = join(tmpdir(), `recall-purgemeta-${randomUUID()}`);
  mkdirSync(recallHome, { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  _resetDb();
  getDb(dbPath());

  // --- Claude session: real prompt + flagged skill injection + heuristic
  //     command echo + whitelisted task notification + assistant reply ---
  const base = { sessionId: SID_CLAUDE, cwd: '/home/u/proj' };
  const user = (uuid: string, text: string, extra?: Record<string, unknown>) => ({
    type: 'user', uuid, timestamp: '2026-08-10T12:00:00.000Z', ...base,
    message: { role: 'user', content: text }, ...extra,
  });
  const claudeLines = [
    user('u-prompt', 'Please add the ingest cleanup pass'),
    user('u-skill', 'Base directory for this skill: /home/u/.claude/skills/recall', { isMeta: true }),
    user('u-cmd', '<command-name>/model</command-name>\n<command-args>opus</command-args>'),
    user('u-task', '<task-notification>Agent found the root cause in db.ts</task-notification>', { isMeta: true }),
    {
      type: 'assistant', uuid: 'a-reply', timestamp: '2026-08-10T12:00:01.000Z', ...base,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Cleanup pass added.' }] },
    },
  ];
  const claudePath = join(recallHome, `${SID_CLAUDE}.jsonl`);
  writeFileSync(claudePath, claudeLines.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const claudeRecords: MessageRecord[] = ['u-prompt', 'u-skill', 'u-cmd', 'u-task', 'a-reply'].map((id, i) => ({
    message_id: id,
    session_id: SID_CLAUDE,
    message_seq: i,
    message_text: typeof claudeLines[i]!.message.content === 'string'
      ? (claudeLines[i]!.message.content as string)
      : 'Cleanup pass added.',
    project_id: '/home/u/proj',
    created_at: Date.now(),
    message_role: i === 4 ? 'assistant' : 'user',
    retrieval_class: 'hot',
  }));
  insertMessages(claudeRecords, { provenance: provenance(SID_CLAUDE, 'claude', claudePath) });
  insertVector('u-prompt');
  insertVector('u-skill');

  // --- Codex session: AGENTS.md preamble + real user + assistant ---
  const codexEnvelopes = [
    { timestamp: '2026-02-07T20:34:15.000Z', type: 'session_meta', payload: { id: SID_CODEX, cwd: '/home/u/proj', cli_version: '0.92.0' } },
    { timestamp: '2026-02-07T20:34:16.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /home/u/proj\n\nAlways run the linter.' }] } },
    { timestamp: '2026-02-07T20:34:17.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please fix the failing test in utils.ts' }] } },
    { timestamp: '2026-02-07T20:34:21.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the off-by-one; tests pass now.' }] } },
  ];
  const codexPath = join(recallHome, `${SID_CODEX}-rollout.jsonl`);
  writeFileSync(codexPath, codexEnvelopes.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // Insert the codex rows the way the PRE-FILTER pipeline would have: every
  // adapted user/assistant entry with text, boilerplate included.
  const codexEntries = loadTranscriptEntries(codexPath, 'codex', SID_CODEX)
    .filter((e) => (e.type === 'user' || e.type === 'assistant') && e.uuid && extractEntryText(e));
  const codexRecords: MessageRecord[] = codexEntries.map((e, i) => ({
    message_id: e.uuid!,
    session_id: SID_CODEX,
    message_seq: i,
    message_text: extractEntryText(e),
    project_id: '/home/u/proj',
    created_at: Date.now(),
    message_role: e.message?.role ?? null,
    retrieval_class: 'hot',
  }));
  expect(codexRecords.length).toBe(3); // preamble + user + assistant
  insertMessages(codexRecords, { provenance: provenance(SID_CODEX, 'codex', codexPath) });
  const preambleId = codexEntries.find((e) =>
    extractEntryText(e).startsWith('# AGENTS.md instructions for'))!.uuid!;
  insertVector(preambleId);

  // --- Orphan session: transcript gone; its boilerplate row must SURVIVE ---
  insertMessages(
    [{
      message_id: 'orphan-cmd',
      session_id: SID_ORPHAN,
      message_seq: 0,
      message_text: '<command-name>/orphan</command-name>',
      project_id: '/home/u/proj',
      created_at: Date.now(),
      message_role: 'user',
      retrieval_class: 'hot',
    }],
    { provenance: provenance(SID_ORPHAN, 'claude', join(recallHome, 'gone.jsonl')) },
  );

  // --- No-path provenance row (empty transcript_path backfill artifact) ---
  insertMessages(
    [{
      message_id: 'nopath-msg',
      session_id: SID_NOPATH,
      message_seq: 0,
      message_text: 'a real message with no provenance path',
      project_id: '/home/u/proj',
      created_at: Date.now(),
      message_role: 'user',
      retrieval_class: 'hot',
    }],
    { provenance: provenance(SID_NOPATH, 'claude', null) },
  );
});

afterAll(() => {
  restoreRoot?.();
  _resetDb();
  if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
});

// ============================================================================
// Tests — sequential: dry-run first, then the real purge, then idempotence.
// ============================================================================

describe('purge-meta', () => {
  const expectDoomedCounts = (s: PurgeMetaSummary) => {
    expect(s.rowsDeleted).toBe(3); // u-skill + u-cmd + codex preamble
    expect(s.vectorRowsDeleted).toBe(2); // u-skill + codex preamble
    expect(s.whitelistedDoomed).toBe(0);
    expect(s.buckets).toEqual({ 'skill-injection': 1, 'command-echo': 1, 'codex-preamble': 1 });
    expect(s.sessionsScanned).toBe(2);
    expect(s.sessionsSkippedMissing).toBe(1);
    expect(s.sessionsSkippedNoPath).toBe(1);
    expect(s.sessionsFailedParse).toBe(0);
    expect(s.bytesDeleted).toBeGreaterThan(0);
  };

  it('doctor residue probe counts boilerplate, excluding the whitelist', () => {
    // u-skill + u-cmd + codex preamble + orphan-cmd; u-task is whitelisted.
    expect(countMetaResidue(d())).toBe(4);
  });

  it('dry-run reports the doomed set and writes nothing', async () => {
    const before = totalRows();
    const s = await runPurgeMeta({ dryRun: true });
    expect(s.dryRun).toBe(true);
    expectDoomedCounts(s);
    expect(totalRows()).toBe(before);
    expect(vectorCount('u-skill')).toBe(1);
    expect(ftsHits('directory')).toBeGreaterThan(0); // boilerplate still indexed
  });

  it('purges boilerplate rows, their vectors, and their FTS entries', async () => {
    const s = await runPurgeMeta({});
    expect(s.dryRun).toBe(false);
    expectDoomedCounts(s);

    // Claude session: boilerplate gone, dialogue + whitelisted notification kept.
    expect(rowIds(SID_CLAUDE)).toEqual(['u-prompt', 'u-task', 'a-reply']);
    // Codex session: preamble gone, real turns kept.
    expect(rowIds(SID_CODEX)).toHaveLength(2);
    // Orphan session: untouched — never pattern-deleted.
    expect(rowIds(SID_ORPHAN)).toEqual(['orphan-cmd']);
    expect(rowIds(SID_NOPATH)).toEqual(['nopath-msg']);

    // Vectors: doomed rows' vectors deleted, kept rows' vector untouched.
    expect(vectorCount('u-skill')).toBe(0);
    expect(vectorCount('u-prompt')).toBe(1);
    const orphanVectors = Number(
      (d().get('SELECT COUNT(*) AS n FROM message_vectors') as { n: number }).n,
    );
    expect(orphanVectors).toBe(1); // only u-prompt's remains

    // FTS no longer returns the purged text.
    expect(ftsHits('directory')).toBe(0);

    // Residue now = the orphan row only (attributable, acceptable).
    expect(countMetaResidue(d())).toBe(1);
  });

  it('is idempotent — a second run deletes zero', async () => {
    const s = await runPurgeMeta({});
    expect(s.rowsDeleted).toBe(0);
    expect(s.vectorRowsDeleted).toBe(0);
    expect(s.sessionsScanned).toBe(2);
    expect(s.sessionsSkippedMissing).toBe(1);
  });
});
