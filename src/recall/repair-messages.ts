/** Re-read indexed transcripts without deleting sessions, repairing old sequence
 * bases, inherited fork UUIDs and missed tails. Read failures preserve all rows. */
import { getDb } from '../db.js';
import { dbPath } from '../paths.js';
import { ingestSessionMessages } from './message-ingest.js';
import { sessionIdFromPath } from './mtime-scan.js';

export async function repairMessages(): Promise<{ sessions: number; inserted: number; failed: number }> {
  const d = getDb(dbPath());
  const paths = new Map<string, { sessionId: string; vendor: 'claude' | 'codex' }>();
  for (const row of d.all('SELECT transcript_path, vendor FROM ingest_watermark')) {
    paths.set(row.transcript_path, { sessionId: sessionIdFromPath(row.transcript_path, row.vendor), vendor: row.vendor });
  }
  for (const row of d.all('SELECT session_id, transcript_path, vendor FROM session_provenance WHERE transcript_path IS NOT NULL')) {
    paths.set(row.transcript_path, { sessionId: row.session_id, vendor: row.vendor });
  }
  const result = { sessions: paths.size, inserted: 0, failed: 0 };
  for (const [path, { sessionId, vendor }] of paths) {
    const ingest = await ingestSessionMessages(sessionId, path, vendor);
    if (ingest.error) result.failed++;
    else result.inserted += ingest.chunksCreated;
  }
  return result;
}
