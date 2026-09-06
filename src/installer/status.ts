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
import { readEmbedderConfig, readSatelliteConfig } from './config.js';
import { summarizePushLog } from '../satellite/push.js';
import { logsDir } from '../paths.js';
import { readEmbedFailure, type EmbedFailure } from '../recall/embed-failures.js';

/** What `recall status` prints on a satellite: everything resolvable LOCALLY,
 *  so `getStatus()` stays synchronous (printStatus calls it synchronously and
 *  `pending bytes` needs a hub round-trip — that is a doctor line). */
export interface SatelliteStatusReport {
  mode: 'satellite';
  hubUrl: string;
  host: string;
  tokenPresent: boolean;
  lastPush: string | null;
}

export interface StatusReport {
  mode?: 'hub';
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
  embedFailure: EmbedFailure | null;
}

export function getStatus(): StatusReport | SatelliteStatusReport {
  // BEFORE getDb: opening the database here would CREATE one on a machine that
  // must never have one (spec §3.1).
  const sat = readSatelliteConfig();
  if (sat) {
    let lastPush: string | null = null;
    try {
      lastPush = summarizePushLog(readFileSync(join(logsDir(), 'push.log'), 'utf-8')).lastPush;
    } catch { /* no pushes yet */ }
    return {
      mode: 'satellite',
      hubUrl: sat.hubUrl,
      host: sat.host,
      tokenPresent: sat.token !== null,
      lastPush,
    };
  }

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
    mode: 'hub',
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
    embedFailure: readEmbedFailure(),
  };
}

export function printStatus(json: boolean): void {
  const s = getStatus();
  if (json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (s.mode === 'satellite') {
    console.log('recall status (satellite)');
    console.log('-------------------------');
    console.log(`Hub:           ${s.hubUrl}`);
    console.log(`Host:          ${s.host || 'unknown'}`);
    console.log(`Token:         ${s.tokenPresent ? 'present' : 'MISSING — run `recall install --hub … --token …`'}`);
    console.log(`Last push:     ${s.lastPush ?? 'never'}`);
    console.log('No local database — queries run on the hub.');
    return;
  }
  const mb = (s.dbSizeBytes / (1024 * 1024)).toFixed(1);
  console.log('recall status');
  console.log('-------------');
  console.log(`DB:            ${s.dbPath} (${mb} MB)`);
  console.log(`Messages:      ${s.messageCount} searchable${s.agentMessageCount > 0 ? ` (+${s.agentMessageCount} agent-leaf, cold/explicit-read only)` : ''}`);
  console.log(`Last ingest:   ${s.lastIngest ?? 'never'}`);
  console.log(`Embedding gap: ${s.embeddingGap.gapCount} of ${s.embeddingGap.totalMessages} unembedded`);
  if (s.embedFailure) console.log(`Embed failures: ${s.embedFailure.failedMessageIds.length} messages — ${s.embedFailure.reason} (${s.embedFailure.updatedAt})`);
  if (s.embedVersions.coverage < 1) {
    const pct = Math.round(s.embedVersions.coverage * 100);
    console.log(`Embed migration: ${s.embedVersions.current} of ${s.embedVersions.total} at v${EMBED_VERSION} (${pct}%)`);
  }
  console.log(`Embedder:      ${s.embedder.toUpperCase()}`);
  console.log(`Backfill:      ${s.backfillPid === null ? 'none recorded' : `PID ${s.backfillPid} (${s.backfillRunning ? 'running' : 'finished'})`}`);
}
