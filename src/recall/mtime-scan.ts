/**
 * mtime-scan — T1/T2 shared module for steady-state catch-up.
 *
 * Walks the Claude + Codex transcript roots, compares (mtime, size) against
 * the `ingest_watermark` table, and ingests any file whose pair changed.
 * Watermarks advance ONLY after a successful ingest (advance-then-ingest
 * would silently drop turns on partial failure).
 *
 * Float-precision sharp edge: `statSync().mtimeMs` is a float; SQLite's
 * INTEGER affinity stores fractional values as REAL despite the declared
 * column type, so the `===` compare on read-back fails forever and the
 * scan re-ingests every file on every invocation. Normalize at the boundary
 * with `Math.floor(stat.mtimeMs)` — the same `Math.floor` pattern Day 2's
 * jsonl-reader.ts already uses for its etag cache.
 *
 * Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME` env overrides so that users
 * who relocate their transcript roots still get scanned.
 *
 * @module recall/mtime-scan
 */

import { glob } from 'glob';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../db.js';
import { dbPath } from '../paths.js';
import { log } from '../log.js';
import { ingestSessionMessages } from './message-ingest.js';

interface WatermarkRow {
  transcript_path: string;
  last_mtime: number;
  last_size: number;
  vendor: 'claude' | 'codex';
}

export interface ScanResult {
  scanned: number;
  unchanged: number;
  ingested: number;
  failed: number;
}

export async function mtimeScan(opts?: { vendors?: ('claude' | 'codex')[] }): Promise<ScanResult> {
  const vendors = opts?.vendors ?? ['claude', 'codex'];
  const claudeRoot = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  const codexRoot = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');

  const patterns: Array<[string, 'claude' | 'codex']> = [];
  if (vendors.includes('claude')) patterns.push([join(claudeRoot, 'projects', '**', '*.jsonl'), 'claude']);
  if (vendors.includes('codex')) patterns.push([join(codexRoot, 'sessions', '**', '*.jsonl'), 'codex']);

  const db = getDb(dbPath());
  const watermarks = new Map<string, WatermarkRow>();
  const rows = db.all('SELECT * FROM ingest_watermark') as unknown as WatermarkRow[];
  for (const row of rows) {
    watermarks.set(row.transcript_path, row);
  }

  const result: ScanResult = { scanned: 0, unchanged: 0, ingested: 0, failed: 0 };

  for (const [pattern, vendor] of patterns) {
    const files = await glob(pattern, { nodir: true });
    for (const file of files) {
      result.scanned++;
      let stat;
      try { stat = statSync(file); } catch { continue; }
      const known = watermarks.get(file);
      const mtimeInt = Math.floor(stat.mtimeMs);
      if (known && known.last_mtime === mtimeInt && known.last_size === stat.size) {
        result.unchanged++;
        continue;
      }
      const sessionId = sessionIdFromPath(file, vendor);
      try {
        // ingestSessionMessages signals load/parse and DB-insert failures via a
        // returned `error` field (soft errors), not by throwing. Treat those as
        // failures too — otherwise the watermark would advance past a file that
        // never actually ingested, marking a corrupt transcript permanently
        // clean (it would only be retried if its mtime/size later changed).
        const ingestResult = await ingestSessionMessages(sessionId, file, vendor);
        if (ingestResult.error) {
          result.failed++;
          log({
            level: 'warn',
            source: 'recall:mtime-scan',
            summary: `Ingest failed, watermark not advanced: ${file}`,
            data: { path: file, vendor, error: ingestResult.error },
          });
          continue;
        }
        // Watermark advances ONLY after a successful ingest. On failure, the
        // next scan retries — advance-then-ingest would silently drop missed
        // turns on partial failure.
        db.run(
          `INSERT INTO ingest_watermark (transcript_path, last_mtime, last_size, vendor)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(transcript_path) DO UPDATE SET last_mtime=excluded.last_mtime, last_size=excluded.last_size`,
          [file, mtimeInt, stat.size, vendor],
        );
        result.ingested++;
      } catch {
        result.failed++;
      }
    }
  }
  return result;
}

function sessionIdFromPath(file: string, vendor: 'claude' | 'codex'): string {
  // Claude: ~/.claude/projects/<encoded>/<session-uuid>.jsonl  → basename minus .jsonl
  // Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl → trailing uuid
  const base = file.split('/').pop()!.replace(/\.jsonl$/, '');
  if (vendor === 'claude') return base;
  const m = base.match(/^rollout-.+-([0-9a-f-]{36})$/i);
  return m ? m[1] : base;
}
