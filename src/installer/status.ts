/**
 * status — operational snapshot of an installed recall.
 *
 * Reports DB size, message count, last ingest time, embedding gap, active
 * backfill PID, and the active embedding backend (GPU/CPU from config.json).
 *
 * @module installer/status
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.js';
import { dbPath, runDir } from '../paths.js';
import { getEmbeddingGapStats } from '../recall/message-store.js';
import { readEmbedderConfig } from './config.js';

export interface StatusReport {
  dbPath: string;
  dbSizeBytes: number;
  messageCount: number;
  lastIngest: string | null;
  embeddingGap: { totalMessages: number; gapCount: number };
  backfillPid: number | null;
  backfillRunning: boolean;
  embedder: 'gpu' | 'cpu';
}

export function getStatus(): StatusReport {
  const d = getDb(dbPath());
  const messageCount = (d.get('SELECT COUNT(*) AS c FROM messages') as { c: number }).c;
  const lastRow = d.get('SELECT MAX(created_at) AS m FROM messages') as { m: number | null };
  const lastIngest = lastRow.m ? new Date(lastRow.m).toISOString() : null;
  const dbSizeBytes = existsSync(dbPath()) ? statSync(dbPath()).size : 0;
  const embeddingGap = getEmbeddingGapStats();

  let backfillPid: number | null = null;
  let backfillRunning = false;
  const pidFile = join(runDir(), 'backfill.pid');
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isNaN(pid)) {
      backfillPid = pid;
      try { process.kill(pid, 0); backfillRunning = true; } catch { backfillRunning = false; }
    }
  }

  return {
    dbPath: dbPath(),
    dbSizeBytes,
    messageCount,
    lastIngest,
    embeddingGap,
    backfillPid,
    backfillRunning,
    embedder: readEmbedderConfig().mode,
  };
}

export function printStatus(json: boolean): void {
  const s = getStatus();
  if (json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  const mb = (s.dbSizeBytes / (1024 * 1024)).toFixed(1);
  console.log('recall status');
  console.log('-------------');
  console.log(`DB:            ${s.dbPath} (${mb} MB)`);
  console.log(`Messages:      ${s.messageCount}`);
  console.log(`Last ingest:   ${s.lastIngest ?? 'never'}`);
  console.log(`Embedding gap: ${s.embeddingGap.gapCount} of ${s.embeddingGap.totalMessages} unembedded`);
  console.log(`Embedder:      ${s.embedder.toUpperCase()}`);
  console.log(`Backfill:      ${s.backfillPid === null ? 'none recorded' : `PID ${s.backfillPid} (${s.backfillRunning ? 'running' : 'finished'})`}`);
}
