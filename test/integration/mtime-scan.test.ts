/**
 * mtime-scan gap-recovery test.
 *
 * 1. Ingest a synthetic session A via the regular pipeline (Day 2's
 *    ingestSessionMessages). Note its watermark.
 * 2. Append two raw turns to A's JSONL externally — no Stop hook fire.
 * 3. Call mtimeScan(). Assert: result.ingested ≥ 1, the new turn's content
 *    is FTS5-searchable, watermark advanced.
 * 4. Re-run mtimeScan() with no changes. Assert: every file reports
 *    `unchanged`, latency stays well within the soft budget on a small
 *    fixture.
 * 5. Float-precision regression: watermark.last_mtime must be the integer
 *    Math.floor(mtimeMs). A subsequent scan must mark the file unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, statSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

let recallHome: string;
let claudeRoot: string;
let restoreRoot: () => void;
let originalEnvClaudeConfigDir: string | undefined;
let originalEnvCodexHome: string | undefined;

function writeSessionLines(filePath: string, sessionId: string, count: number, prefix: string): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const uuid = `${sessionId}-msg-${i}-${randomUUID().slice(0, 6)}`;
    lines.push(JSON.stringify({
      type: role,
      uuid,
      parentUuid: i === 0 ? null : `${sessionId}-msg-${i - 1}`,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      message: {
        role,
        content: `${prefix} turn-${i} ${role} payload-${randomUUID().slice(0, 8)} extra padding to clear MIN_EMBED_CHARS`,
      },
    }));
  }
  writeFileSync(filePath, lines.join('\n') + '\n');
}

function appendSessionLines(filePath: string, sessionId: string, startSeq: number, count: number, prefix: string): string[] {
  const ids: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const role = seq % 2 === 0 ? 'user' : 'assistant';
    const uuid = `${sessionId}-msg-${seq}-${randomUUID().slice(0, 6)}`;
    ids.push(uuid);
    lines.push(JSON.stringify({
      type: role,
      uuid,
      parentUuid: `${sessionId}-msg-${seq - 1}`,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, i)).toISOString(),
      message: {
        role,
        content: `${prefix} turn-${seq} ${role} payload-${randomUUID().slice(0, 8)} extra padding to clear MIN_EMBED_CHARS`,
      },
    }));
  }
  appendFileSync(filePath, lines.join('\n') + '\n');
  return ids;
}

describe('mtime-scan gap recovery', () => {
  beforeAll(() => {
    recallHome = join(tmpdir(), `recall-mtime-test-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    claudeRoot = join(recallHome, 'claude-fake');
    mkdirSync(join(claudeRoot, 'projects', 'test-proj'), { recursive: true });
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

  it('recovers turns appended after the initial ingest', async () => {
    const sessionId = `mtime-sess-${randomUUID()}`;
    const projectDir = join(claudeRoot, 'projects', 'test-proj');
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    writeSessionLines(transcriptPath, sessionId, 3, 'baseline');

    // Step 1: regular ingest + watermark write (mimic what mtimeScan does on
    // a never-seen file).
    const firstScan = await mtimeScan();
    expect(firstScan.ingested).toBeGreaterThanOrEqual(1);

    const db = getDb(dbPath());
    const initialWatermark = db.get(
      'SELECT last_mtime, last_size FROM ingest_watermark WHERE transcript_path = ?',
      [transcriptPath],
    ) as { last_mtime: number; last_size: number } | undefined;
    expect(initialWatermark).toBeDefined();

    // Float-precision regression: stored value must be the integer floor.
    const initialStat = statSync(transcriptPath);
    expect(initialWatermark!.last_mtime).toBe(Math.floor(initialStat.mtimeMs));

    // Step 2: append two raw turns externally — no Stop hook.
    const phrase = `appended-marker-${randomUUID().slice(0, 8)}`;
    appendSessionLines(transcriptPath, sessionId, 3, 2, phrase);

    // Force mtime to differ from the watermark; ext4 mtime granularity can
    // collapse an immediate append onto the same millisecond on fast
    // filesystems, defeating the (mtime, size) compare.
    const future = new Date(Date.now() + 5000);
    utimesSync(transcriptPath, future, future);

    // Step 3: mtimeScan picks it up.
    const secondScan = await mtimeScan();
    expect(secondScan.ingested).toBeGreaterThanOrEqual(1);

    // FTS5 should now find the appended marker. Wrap in double quotes so
    // hyphens in the phrase aren't parsed as FTS5 operators.
    const matches = db.all(
      `SELECT m.message_id FROM messages_fts f
       CROSS JOIN messages m ON m.rowid = f.rowid
       WHERE messages_fts MATCH ?`,
      [`"${phrase}"`],
    );
    expect(matches.length).toBeGreaterThan(0);

    // Watermark must have advanced.
    const advanced = db.get(
      'SELECT last_mtime, last_size FROM ingest_watermark WHERE transcript_path = ?',
      [transcriptPath],
    ) as { last_mtime: number; last_size: number } | undefined;
    expect(advanced).toBeDefined();
    expect(advanced!.last_mtime).toBeGreaterThanOrEqual(initialWatermark!.last_mtime);

    // Step 4: a no-change rescan reports unchanged for the file and is fast.
    const t0 = Date.now();
    const thirdScan = await mtimeScan();
    const dt = Date.now() - t0;
    expect(thirdScan.ingested).toBe(0);
    expect(thirdScan.unchanged).toBeGreaterThanOrEqual(1);
    // Soft smoke check — small fixture should clear comfortably.
    expect(dt).toBeLessThan(500);

    // Step 5: float-precision — the stored integer must match Math.floor of
    // the current mtime, and the rescan must NOT count the file as ingested.
    const afterStat = statSync(transcriptPath);
    const watermarkPost = db.get(
      'SELECT last_mtime FROM ingest_watermark WHERE transcript_path = ?',
      [transcriptPath],
    ) as { last_mtime: number } | undefined;
    expect(watermarkPost!.last_mtime).toBe(Math.floor(afterStat.mtimeMs));
  });
});
