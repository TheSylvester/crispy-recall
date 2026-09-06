import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { ingestSessionMessages, embedMessageBatch, embedSessionMessages } from '../../src/recall/message-ingest.js';
import { getMessageByUuid, getUnembeddedMessages, insertMessages, insertMessageVectors } from '../../src/recall/message-store.js';
import { parseJsonlFile, readLinesFromOffset } from '../../src/adapters/claude/jsonl-reader.js';
import { parseCodexJsonlFile } from '../../src/adapters/codex/codex-jsonl-reader.js';
import { readEmbedFailure } from '../../src/recall/embed-failures.js';
import { mtimeScan } from '../../src/recall/mtime-scan.js';
import { runPushIngest } from '../../src/hub/ingest-queue.js';
import { repairMessages } from '../../src/recall/repair-messages.js';
import { buildEmbedText } from '../../src/recall/embed-config.js';

const embedBatch = vi.hoisted(() => vi.fn());
vi.mock('../../src/recall/embedder.js', () => ({ embedBatch }));
let dir: string, restore: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recall-ingest-resilience-'));
  restore = _setTestRoot(dir); _resetDb(); embedBatch.mockReset();
});
afterEach(() => { _resetDb(); restore(); rmSync(dir, { recursive: true, force: true }); });
const entry = (uuid: string, content: string, extra = {}) => ({
  type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content }, ...extra,
});
function transcript(id: string, entries: unknown[]) {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('ingest error and identity recovery', () => {
  it('read errors throw for both vendors and force ingest preserves existing rows', async () => {
    const path = transcript('read-error', [entry('read-message', 'durable text')]);
    expect((await ingestSessionMessages('read-error', path, 'claude')).chunksCreated).toBe(1);
    rmSync(path);
    expect(() => parseJsonlFile(path)).toThrow();
    expect(() => parseCodexJsonlFile(path)).toThrow();
    const result = await ingestSessionMessages('read-error', path, 'claude', { force: true });
    expect(result.error).toMatch('Failed to load');
    expect(getMessageByUuid('read-error', 'read-message')?.message_text).toBe('durable text');
  });
  it('counts inserts honestly and preserves parent/fork history with legacy UUID reads', async () => {
    const shared = entry('shared-uuid', 'inherited history');
    const parent = transcript('parent', [shared]);
    const fork = transcript('fork', [shared, entry('fork-new', 'new fork turn')]);
    expect((await ingestSessionMessages('parent', parent, 'claude')).chunksCreated).toBe(1);
    expect((await ingestSessionMessages('fork', fork, 'claude')).chunksCreated).toBe(2);
    const again = await ingestSessionMessages('fork', fork, 'claude');
    expect(again.chunksCreated).toBe(0); expect(again.recordsOffered).toBe(2);
    expect(getMessageByUuid('fork', 'shared-uuid')?.message_text).toBe('inherited history');
    expect(getMessageByUuid('parent', 'shared-uuid')?.message_id).toBe('shared-uuid');
    expect((await ingestSessionMessages('fork', fork, 'claude', { force: true })).chunksCreated).toBe(2);
  });
  it('repairs old meta-filter sequence shifts without deleting rows or needing changed mtimes', async () => {
    const path = transcript('sequence', [entry('first', 'first'), entry('meta', 'hidden setup', { isMeta: true }), entry('third', 'third'), entry('fourth', 'fourth')]);
    await ingestSessionMessages('sequence', path, 'claude');
    const d = getDb(dbPath());
    // Legacy meta rows can still exist from before the filtering release.
    d.run("INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at) VALUES ('meta', 'sequence', 1, 'legacy hidden setup', 1)");
    // Mixed pre/post-filter ingestion produced third=2 and fourth=2.
    d.run("UPDATE messages SET message_seq = 2 WHERE message_id = 'fourth'");
    const repaired = await repairMessages();
    expect(repaired).toEqual({ sessions: 1, inserted: 0, failed: 0 });
    expect(d.all('SELECT message_seq FROM messages ORDER BY message_seq').map(r => r.message_seq)).toEqual([0, 1, 2, 3]);
    expect(d.get("SELECT count(*) AS n FROM messages WHERE message_id = 'meta'").n).toBe(1);
  });
});

it.each(['é', '€', '😀'].flatMap(char => Array.from({length: Buffer.byteLength(char) - 1}, (_, i) => [char, i + 1] as const)))('preserves %s split after byte %i at a 64 KiB boundary and exact resume offset', (char, split) => {
  const prefix = '{"type":"user","uuid":"unicode","message":{"content":"';
  const line = prefix + 'x'.repeat(65536 - Buffer.byteLength(prefix) - split) + char + '"}}\n';
  const tail = JSON.stringify(entry('tail', 'second')) + '\n';
  const path = join(dir, 'utf8.jsonl'); writeFileSync(path, line + tail);
  const read = readLinesFromOffset(path, 0);
  expect(read.entries).toHaveLength(2);
  expect(JSON.stringify(read.entries[0])).toContain(char);
  expect(JSON.stringify(read.entries[0])).not.toContain('\ufffd');
  expect(read.newOffset).toBe(Buffer.byteLength(line + tail));
  expect(readLinesFromOffset(path, read.newOffset).entries).toEqual([]);
});

it('strips NUL at ingest and on legacy adjacency input before any embed backend', async () => {
  const path = transcript('nul', [entry('nul-first', 'hello\0world'), entry('nul-second', 'ok')]);
  await ingestSessionMessages('nul', path, 'claude');
  expect(getMessageByUuid('nul', 'nul-first')?.message_text).toBe('helloworld');
  expect(buildEmbedText('o\0k', 'prev\0text')).toBe('prevtext\nok');
  embedBatch.mockImplementation(async (texts: string[]) => {
    expect(texts.every(t => !t.includes('\0'))).toBe(true);
    return texts.map(() => new Float32Array([1, 0]));
  });
  expect(await embedMessageBatch([{ message_id: 'nul-first', message_text: 'legacy\0text' }])).toBe(1);
});

it('bounds failed row retries, releases later candidates, and leaves diagnostic evidence', async () => {
  const ids = ['permanent-failure', 'later-message'];
  insertMessages(ids.map((id, i) => ({ message_id: id, session_id: id, message_seq: 0, message_text: 'x'.repeat(80), project_id: null, created_at: 10 - i, message_role: 'user' })));
  embedBatch.mockRejectedValue(new Error('embedder offline'));
  for (let i = 0; i < 3; i++) expect(await embedMessageBatch(getUnembeddedMessages(1))).toBe(0);
  expect(embedBatch).toHaveBeenCalledTimes(9);
  expect(getUnembeddedMessages(1)[0]?.message_id).toBe('later-message');
  expect(readEmbedFailure()?.failedMessageIds).toContain('permanent-failure');
  expect(readEmbedFailure()?.attempts).toBe(3);
  expect(await embedSessionMessages('permanent-failure')).toBe(0);
  expect(embedBatch).toHaveBeenCalledTimes(9);
  embedBatch.mockResolvedValue([new Float32Array([1, 0])]);
  expect(await embedMessageBatch([{ message_id: ids[0]!, message_text: 'recovered' }])).toBe(1);
  expect(readEmbedFailure()).toBeNull();
});


it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not watermark an unreadable tail and hub reset preserves its rows', async () => {
  const root = join(dir, 'claude'); mkdirSync(join(root, 'projects', 'fixture'), { recursive: true });
  const path = join(root, 'projects', 'fixture', 'unreadable.jsonl');
  const first = JSON.stringify(entry('readable-first', 'first turn')) + '\n';
  writeFileSync(path, first);
  await mtimeScan({ roots: [{ root, vendor: 'claude' }] });
  const d = getDb(dbPath());
  const original = d.get('SELECT * FROM ingest_watermark WHERE transcript_path = ?', [path]);
  writeFileSync(path, first + JSON.stringify(entry('unreadable-tail', 'second turn')) + '\n');
  chmodSync(path, 0);
  try {
    const scan = await mtimeScan({ roots: [{ root, vendor: 'claude' }] });
    expect(scan.failed).toBe(1);
    expect(d.get('SELECT * FROM ingest_watermark WHERE transcript_path = ?', [path])).toEqual(original);
    // Remove local provenance so the hub fixture can exercise its reset read
    // failure rather than correctly refusing this as a cross-host collision.
    d.run("DELETE FROM session_provenance WHERE session_id = 'unreadable'");
    const st = statSync(path);
    const outcome = await runPushIngest({ host: 'fixture', vendor: 'claude', rel: 'projects/fixture/unreadable.jsonl', abs: path, reset: true, meta: {}, mtimeInt: Math.floor(st.mtimeMs), size: st.size }, { log() {}, spawnEmbed() {}, onRefused() {} });
    expect(outcome).toBe('failed');
    expect(getMessageByUuid('unreadable', 'readable-first')).not.toBeNull();
    expect(d.get('SELECT * FROM ingest_watermark WHERE transcript_path = ?', [path])).toEqual(original);
  } finally { chmodSync(path, 0o600); }
  expect((await mtimeScan({ roots: [{ root, vendor: 'claude' }] })).ingested).toBe(1);
  expect(getMessageByUuid('unreadable', 'unreadable-tail')).not.toBeNull();
});


it('invalidates adjacency vectors when repair fills a missing earlier turn', async () => {
  const path = transcript('missing-predecessor', [entry('before', 'earlier turn'), entry('after', 'short reply')]);
  insertMessages([{ message_id: 'after', session_id: 'missing-predecessor', message_seq: 1, message_text: 'short reply', project_id: null, created_at: 1, message_role: 'user' }]);
  insertMessageVectors([{ messageId: 'after', embeddingQ8: new Int8Array([1, 0]), norm: 1, quantScale: 1 }]);
  await ingestSessionMessages('missing-predecessor', path, 'claude');
  expect(getDb(dbPath()).get("SELECT count(*) AS n FROM message_vectors WHERE message_id='after'").n).toBe(0);
});

it('preserves indexed prefix order when a source was shortened and appends new turns safely', async () => {
  const path = transcript('shortened', [entry('old-a', 'old a'), entry('old-b', 'old b')]);
  await ingestSessionMessages('shortened', path, 'claude');
  writeFileSync(path, [entry('old-b', 'old b'), entry('new-c', 'new c')].map(e => JSON.stringify(e)).join('\n'));
  await repairMessages();
  expect(getDb(dbPath()).all("SELECT message_id, message_seq FROM messages WHERE session_id='shortened' ORDER BY message_seq")).toEqual([
    { message_id: 'old-a', message_seq: 0 }, { message_id: 'old-b', message_seq: 1 }, { message_id: 'new-c', message_seq: 2 },
  ]);
});


it('selects legacy leading-NUL text before normalization', () => {
  insertMessages([{ message_id: 'leading-nul', session_id: 'leading-nul-session', message_seq: 0, message_text: '\0' + 'meaningful text '.repeat(8), project_id: null, created_at: 1, message_role: 'user' }]);
  const pending = getUnembeddedMessages(10);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.embed_text).not.toContain('\0');
});
