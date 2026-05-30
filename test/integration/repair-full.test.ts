/**
 * repair --fts / --vectors / --full tests.
 *
 * `repairFull` is destructive: it DELETEs every message (cascading to vectors
 * + FTS) and the ingest_watermark, then reingests from JSONL. This verifies:
 *   - the DELETE actually fires (a DB-only orphan row with no transcript is
 *     gone afterward),
 *   - reingest restores the real transcript-backed rows,
 *   - the ingest_watermark is cleared AND rebuilt (the documented footgun:
 *     forget to clear it and steady-state catch-up reingests nothing).
 * Plus repairVectors clears embeddings and repairFts leaves FTS healthy.
 *
 * Tiny message bodies (< MIN_EMBED_CHARS) keep the embedding gap at 0, so no
 * llama-server / model download is triggered — CI-friendly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { repairFull, repairVectors, repairFts, integrityCheck } from '../../src/installer/repair.js';
import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

let recallHome: string;
let claudeRoot: string;
let restoreRoot: () => void;
let origClaudeConfigDir: string | undefined;
let origCodexHome: string | undefined;

function writeFixtureSession(filePath: string, sessionId: string): void {
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(JSON.stringify({
      type: role,
      uuid: `${sessionId}-msg-${i}`,
      parentUuid: i === 0 ? null : `${sessionId}-msg-${i - 1}`,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      message: { role, content: `hi ${i}` }, // tiny → gap stays 0
    }));
  }
  writeFileSync(filePath, lines.join('\n') + '\n');
}

function count(sql: string): number {
  return (getDb(dbPath()).get(sql) as { c: number }).c;
}

describe('repair', () => {
  beforeAll(async () => {
    recallHome = join(tmpdir(), `recall-repair-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    claudeRoot = join(recallHome, 'claude-fake');
    mkdirSync(join(claudeRoot, 'projects', 'proj-a'), { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    origClaudeConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    origCodexHome = process.env['CODEX_HOME'];
    process.env['CLAUDE_CONFIG_DIR'] = claudeRoot;
    process.env['CODEX_HOME'] = join(recallHome, 'codex-empty');
    _resetDb();

    // Seed 3 transcript sessions and index them via the steady-state scan.
    const projectDir = join(claudeRoot, 'projects', 'proj-a');
    for (let i = 0; i < 3; i++) {
      writeFixtureSession(join(projectDir, `fix-sess-${i}.jsonl`), `fix-sess-${i}`);
    }
    await mtimeScan();
  });

  afterAll(() => {
    restoreRoot?.();
    _resetDb();
    if (origClaudeConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = origClaudeConfigDir;
    if (origCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = origCodexHome;
    if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
  });

  it('full repair deletes orphans, reingests from JSONL, and rebuilds the watermark', async () => {
    const realMessages = count('SELECT COUNT(*) AS c FROM messages'); // 3 sessions × 4
    expect(realMessages).toBe(12);
    expect(count('SELECT COUNT(*) AS c FROM ingest_watermark')).toBe(3);

    // Inject a DB-only orphan with no backing transcript — repair must remove it.
    getDb(dbPath()).run(
      `INSERT INTO messages
         (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['orphan-1', 'bogus-orphan', 0, 'no transcript backs this row', null, 1, 'user'],
    );
    expect(count("SELECT COUNT(*) AS c FROM messages WHERE session_id = 'bogus-orphan'")).toBe(1);

    await repairFull({ yes: true });

    // Orphan gone (DELETE fired); real rows reingested; watermark rebuilt.
    expect(count("SELECT COUNT(*) AS c FROM messages WHERE session_id = 'bogus-orphan'")).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messages')).toBe(realMessages);
    expect(count('SELECT COUNT(*) AS c FROM ingest_watermark')).toBe(3);
    // FTS index is consistent with the reingested rows.
    expect(integrityCheck().ftsOk).toBe(true);
  });

  it('repairVectors clears embeddings without touching messages', () => {
    const msgs = count('SELECT COUNT(*) AS c FROM messages');
    // Attach a vector to an existing message so there is something to clear.
    const mid = (getDb(dbPath()).get('SELECT message_id FROM messages LIMIT 1') as { message_id: string }).message_id;
    getDb(dbPath()).run(
      `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale) VALUES (?, ?, ?, ?)`,
      [mid, Buffer.from([1, 2, 3]), 1.0, 0.5],
    );
    expect(count('SELECT COUNT(*) AS c FROM message_vectors')).toBe(1);

    repairVectors();

    expect(count('SELECT COUNT(*) AS c FROM message_vectors')).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messages')).toBe(msgs); // messages untouched
  });

  it('repairFts rebuilds the index and leaves it healthy', () => {
    expect(() => repairFts()).not.toThrow();
    expect(integrityCheck().ftsOk).toBe(true);
  });
});
