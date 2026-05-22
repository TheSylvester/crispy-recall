/**
 * recall backfill idempotency test.
 *
 * 1. Pre-seed 5 fixture JSONL sessions on disk under a fake Claude root.
 * 2. Run `startRecallCatchup({ autoEmbed: true })` (the in-process body of
 *    `recall backfill --auto-embed`) followed by the post-run mtimeScan
 *    sweep — same pair `runBackfill()` invokes in src/cli/recall.ts.
 * 3. Snapshot row counts in messages, messages_fts, message_vectors,
 *    ingest_watermark, plus getEmbeddingGapStats().
 * 4. Run the same pair again.
 * 5. Assert row counts are unchanged and gap stats match.
 *
 * Uses tiny message bodies (< MIN_EMBED_CHARS = 50) so getEmbeddingGapStats
 * returns gapCount=0 and the embedding phase is skipped — keeping the test
 * CI-friendly (no llama-server, no model download).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { startRecallCatchup } from '../../src/recall/catchup.js';
import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { getEmbeddingGapStats } from '../../src/recall/message-store.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

let recallHome: string;
let claudeRoot: string;
let restoreRoot: () => void;
let originalEnvClaudeConfigDir: string | undefined;
let originalEnvCodexHome: string | undefined;

function writeFixtureSession(filePath: string, sessionId: string): void {
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const uuid = `${sessionId}-msg-${i}-${randomUUID().slice(0, 6)}`;
    lines.push(JSON.stringify({
      type: role,
      uuid,
      parentUuid: i === 0 ? null : `${sessionId}-msg-${i - 1}`,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      // Tiny body so length < MIN_EMBED_CHARS — gap stays 0.
      message: { role, content: `hi ${i}` },
    }));
  }
  writeFileSync(filePath, lines.join('\n') + '\n');
}

interface RowCounts {
  messages: number;
  messages_fts: number;
  message_vectors: number;
  ingest_watermark: number;
}

function snapshotCounts(): RowCounts {
  const db = getDb(dbPath());
  const one = (sql: string) => (db.get(sql) as { c: number }).c;
  return {
    messages: one('SELECT COUNT(*) AS c FROM messages'),
    messages_fts: one('SELECT COUNT(*) AS c FROM messages_fts'),
    message_vectors: one('SELECT COUNT(*) AS c FROM message_vectors'),
    ingest_watermark: one('SELECT COUNT(*) AS c FROM ingest_watermark'),
  };
}

describe('recall backfill idempotency', () => {
  beforeAll(() => {
    recallHome = join(tmpdir(), `recall-backfill-test-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    claudeRoot = join(recallHome, 'claude-fake');
    mkdirSync(join(claudeRoot, 'projects', 'proj-a'), { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    originalEnvClaudeConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    originalEnvCodexHome = process.env['CODEX_HOME'];
    process.env['CLAUDE_CONFIG_DIR'] = claudeRoot;
    process.env['CODEX_HOME'] = join(recallHome, 'codex-empty');
    _resetDb();
  });

  afterAll(() => {
    restoreRoot?.();
    _resetDb();
    if (originalEnvClaudeConfigDir === undefined) {
      delete process.env['CLAUDE_CONFIG_DIR'];
    } else {
      process.env['CLAUDE_CONFIG_DIR'] = originalEnvClaudeConfigDir;
    }
    if (originalEnvCodexHome === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = originalEnvCodexHome;
    }
    if (recallHome && existsSync(recallHome)) {
      rmSync(recallHome, { recursive: true, force: true });
    }
  });

  it('re-running backfill does not duplicate rows or shift gap stats', async () => {
    const projectDir = join(claudeRoot, 'projects', 'proj-a');
    for (let i = 0; i < 5; i++) {
      const sessionId = `fix-sess-${i}-${randomUUID().slice(0, 6)}`;
      writeFixtureSession(join(projectDir, `${sessionId}.jsonl`), sessionId);
    }

    // First pass: startRecallCatchup + post-run mtimeScan (mirrors runBackfill).
    await startRecallCatchup({ autoEmbed: true });
    await mtimeScan();

    const firstCounts = snapshotCounts();
    const firstGap = getEmbeddingGapStats();
    expect(firstCounts.messages).toBeGreaterThan(0);
    expect(firstCounts.ingest_watermark).toBe(5);

    // Second pass — should be a no-op for counts and gap stats.
    await startRecallCatchup({ autoEmbed: true });
    await mtimeScan();

    const secondCounts = snapshotCounts();
    const secondGap = getEmbeddingGapStats();
    expect(secondCounts).toEqual(firstCounts);
    expect(secondGap).toEqual(firstGap);
  });
});
