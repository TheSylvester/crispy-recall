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
import { getEmbeddingGapStats, getEmbedVersionStats } from '../recall/message-store.js';
import type { EmbedVersionStats } from '../recall/message-store.js';
import { EMBED_VERSION } from '../recall/embed-config.js';
import { readEmbedderConfig } from './config.js';

export interface StatusReport {
  dbPath: string;
  dbSizeBytes: number;
  /** HOT (canonical, searchable) messages — the retrieval/embedding denominator. */
  messageCount: number;
  /** Cold agent-leaf messages: durable and explicitly readable, never searched
   *  or embedded. Reported separately so they don't inflate the denominator. */
  agentMessageCount: number;
  lastIngest: string | null;
  embeddingGap: { totalMessages: number; gapCount: number };
  /** Per-version vector coverage — surfaces an in-progress embed_version re-embed. */
  embedVersions: EmbedVersionStats;
  backfillPid: number | null;
  backfillRunning: boolean;
  embedder: 'gpu' | 'cpu';
}

export function getStatus(): StatusReport {
  const d = getDb(dbPath());
  const counts = d.get(
    `SELECT
       COALESCE(SUM(CASE WHEN retrieval_class = 'hot' THEN 1 ELSE 0 END), 0) AS hot,
       COALESCE(SUM(CASE WHEN retrieval_class != 'hot' THEN 1 ELSE 0 END), 0) AS agent
     FROM messages`,
  ) as { hot: number; agent: number };
  const messageCount = counts.hot;
  const agentMessageCount = counts.agent;
  const lastRow = d.get('SELECT MAX(created_at) AS m FROM messages') as { m: number | null };
  const lastIngest = lastRow.m ? new Date(lastRow.m).toISOString() : null;
  const dbSizeBytes = existsSync(dbPath()) ? statSync(dbPath()).size : 0;
  const embeddingGap = getEmbeddingGapStats();
  const embedVersions = getEmbedVersionStats();

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
    agentMessageCount,
    lastIngest,
    embeddingGap,
    embedVersions,
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
  console.log(`Messages:      ${s.messageCount} searchable${s.agentMessageCount > 0 ? ` (+${s.agentMessageCount} agent-leaf, cold/explicit-read only)` : ''}`);
  console.log(`Last ingest:   ${s.lastIngest ?? 'never'}`);
  console.log(`Embedding gap: ${s.embeddingGap.gapCount} of ${s.embeddingGap.totalMessages} unembedded`);
  if (s.embedVersions.coverage < 1) {
    const pct = Math.round(s.embedVersions.coverage * 100);
    console.log(`Embed migration: ${s.embedVersions.current} of ${s.embedVersions.total} at v${EMBED_VERSION} (${pct}%)`);
  }
  console.log(`Embedder:      ${s.embedder.toUpperCase()}`);
  console.log(`Backfill:      ${s.backfillPid === null ? 'none recorded' : `PID ${s.backfillPid} (${s.backfillRunning ? 'running' : 'finished'})`}`);
}
