/**
 * project_id derivation on ingest — regression for the "recall only goes back to
 * install day" bug.
 *
 * Backfill calls ingestSessionMessages() WITHOUT a projectId (only the Stop hook
 * passes payload.cwd). Before the fix, every backfilled session landed with a
 * NULL project_id, so the default (CWD-scoped) recall search filtered them all
 * out — leaving only post-install hook-ingested sessions visible.
 *
 * The fix: when no projectId is supplied, derive it from the cwd recorded on the
 * transcript's own entries (both Claude and Codex adapters carry it). An
 * explicitly-passed projectId (the Stop hook) still wins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

const CWD = '/home/u/dev/antidote-dev';

/** A minimal Claude transcript: an operation entry (no cwd) then user/assistant. */
function claudeEntries(sid: string): Array<Record<string, unknown>> {
  return [
    // Leading non-message entry that carries NO cwd — derivation must skip it.
    { type: 'file-history-snapshot', timestamp: '2026-04-17T10:00:00.000Z', sessionId: sid },
    // uuids are the message-table PK (global, INSERT OR IGNORE) — keep them
    // unique per session so cross-test reuse doesn't silently drop rows.
    { type: 'user', uuid: `${sid}-u1`, sessionId: sid, cwd: CWD, timestamp: '2026-04-17T10:00:01.000Z',
      message: { role: 'user', content: 'Fix the billing rollup' } },
    { type: 'assistant', uuid: `${sid}-a1`, sessionId: sid, cwd: CWD, timestamp: '2026-04-17T10:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done — rollup fixed.' }] } },
  ];
}

function projectIdsFor(sessionId: string): Array<string | null> {
  const rows = getDb(dbPath()).all(
    'SELECT DISTINCT project_id FROM messages WHERE session_id = ?',
    [sessionId],
  ) as Array<{ project_id: string | null }>;
  return rows.map((r) => r.project_id);
}

describe('project_id derivation on ingest', () => {
  let recallHome: string;
  let restoreRoot: () => void;

  beforeAll(() => {
    recallHome = join(tmpdir(), `recall-projid-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    _resetDb();
    getDb(dbPath());
  });

  afterAll(() => {
    restoreRoot?.();
    _resetDb();
    if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
  });

  it('backfill (no projectId) derives project_id from the transcript cwd', async () => {
    const sid = 'claude-backfill-1';
    const jsonlPath = join(recallHome, `${sid}.jsonl`);
    writeFileSync(jsonlPath, claudeEntries(sid).map((e) => JSON.stringify(e)).join('\n') + '\n');

    const res = await ingestSessionMessages(sid, jsonlPath, 'claude');
    expect(res.error).toBeUndefined();

    // Every stored message carries the derived project_id — none are NULL.
    expect(projectIdsFor(sid)).toEqual([CWD]);
  });

  it('an explicit projectId (Stop hook) overrides the transcript cwd', async () => {
    const sid = 'claude-hook-1';
    const jsonlPath = join(recallHome, `${sid}.jsonl`);
    writeFileSync(jsonlPath, claudeEntries(sid).map((e) => JSON.stringify(e)).join('\n') + '\n');

    await ingestSessionMessages(sid, jsonlPath, 'claude', { projectId: '/explicit/override' });

    expect(projectIdsFor(sid)).toEqual(['/explicit/override']);
  });

  it('a transcript with no cwd anywhere falls back to NULL', async () => {
    const sid = 'claude-nocwd-1';
    const jsonlPath = join(recallHome, `${sid}.jsonl`);
    const noCwd = [
      { type: 'user', uuid: `${sid}-u1`, sessionId: sid, timestamp: '2026-04-17T10:00:01.000Z',
        message: { role: 'user', content: 'No cwd here' } },
    ];
    writeFileSync(jsonlPath, noCwd.map((e) => JSON.stringify(e)).join('\n') + '\n');

    await ingestSessionMessages(sid, jsonlPath, 'claude');

    expect(projectIdsFor(sid)).toEqual([null]);
  });
});
