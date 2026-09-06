import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { getDb, _resetDb } from '../../src/db.js';
import { checkBindingHealth } from '../../src/installer/doctor.js';
import { getStatus } from '../../src/installer/status.js';

let root: string;
let restore: () => void;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recall-ingest-health-'));
  restore = _setTestRoot(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'recall.js'), '');
  getDb(dbPath());
});
afterEach(() => { _resetDb(); restore(); rmSync(root, { recursive: true, force: true }); });

it('reports watermarked empty sessions and respects canonical provenance without writing', () => {
  const db = getDb(dbPath());
  db.run(`INSERT INTO messages (message_id,session_id,message_seq,message_text,project_id,created_at,message_role)
    VALUES ('message','canonical-child',0,'a real indexed turn','/project',1000,'user')`);
  db.run(`INSERT INTO session_provenance (session_id,vendor,kind,transcript_path,updated_at)
    VALUES ('canonical-child','claude','agent','/transcripts/agent-leaf.jsonl',1000)`);
  db.run(`INSERT INTO ingest_watermark (transcript_path,last_mtime,last_size,vendor)
    VALUES ('/transcripts/agent-leaf.jsonl',1,100,'claude'),('/transcripts/empty.jsonl',1,100,'claude')`);
  const before = db.get('SELECT COUNT(*) AS n FROM messages');
  expect(checkBindingHealth().emptyWatermarkedTranscripts).toBe(1);
  expect(db.get('SELECT COUNT(*) AS n FROM messages')).toEqual(before);
  expect(db.get('SELECT COUNT(*) AS n FROM ingest_watermark')).toEqual({ n: 2 });
});

it('surfaces durable embedding failure in doctor and status', () => {
  mkdirSync(join(root, 'logs'));
  const failure = { updatedAt: '2026-09-06T00:00:00Z', attempts: 3, reason: 'runtime unavailable', failedMessageIds: ['message'] };
  writeFileSync(join(root, 'logs', 'embed-failure.json'), JSON.stringify(failure));
  const health = checkBindingHealth();
  expect(health.embedFailure).toEqual(failure);
  expect(health.problems.some(p => p.includes('embedding stalled'))).toBe(true);
  expect(getStatus()).toMatchObject({ embedFailure: failure });
});

it('ignores a malformed diagnostic without crashing the health report', () => {
  mkdirSync(join(root, 'logs'));
  writeFileSync(join(root, 'logs', 'embed-failure.json'), 'null');
  expect(checkBindingHealth().embedFailure).toBeNull();
});
