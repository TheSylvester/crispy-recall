/**
 * Push integrity (D1) and hub-refusal surfacing (D5) end to end: the REAL
 * satellite pusher in this process against the REAL hub daemon in a child.
 *
 * The defect this suite pins: the protocol resumed by byte offset only, so a
 * transcript rewritten IN PLACE under a stable mtime (Codex Desktop 0.153.1)
 * had the tail of its NEW bytes appended onto the OLD prefix, and the mirror
 * ended with a torn JSON line at the seam.
 *
 * Two roots, never one. The hub child gets its own `RECALL_HOME` through
 * `sb.env()` (`_setTestRoot` does not cross a process boundary); the satellite
 * lives in THIS process under `_setTestRoot(<satTmp>/.recall)` with
 * CLAUDE_CONFIG_DIR / CODEX_HOME / RECALL_REMOTE_ROOT pointed at temp dirs, so
 * neither side can reach the owner's live `~/.recall` (paths.ts:33-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { _setTestRoot, logsDir } from '../../src/paths.js';
import { hashFileHead, hashFilePrefix, HEAD_BYTES } from '../../src/hub/hash.js';
import { encodeMeta } from '../../src/hub/protocol.js';
import { runPush, computePendingBytes, type PushResult } from '../../src/satellite/push.js';
import {
  appendPath, authHeaders, claudeEntry, createDb, dbRows, hostRecords, hubLogLines, issueToken,
  makeSandbox, req, startDaemon, stagePlaceholders, waitFor, type Daemon, type Sandbox,
} from './helpers/hub-harness.js';

const win32 = platform() === 'win32';
const HOST = 'satx';
const PROJ = '-tmp-integrity';

let hubSb: Sandbox;
let d: Daemon;
let token: string;
let satTmp: string;
let satHome: string;
let satClaude: string;
let restore: () => void;
const prevEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k];
  process.env[k] = v;
}

/** Absolute path of a satellite transcript. */
function satFile(sid: string): string {
  return join(satClaude, 'projects', PROJ, `${sid}.jsonl`);
}

/** Absolute path of its mirror on the hub. */
function mirrorFile(sid: string): string {
  return join(hubSb.remote, HOST, 'claude', 'projects', PROJ, `${sid}.jsonl`);
}

function relOf(sid: string): string {
  return `projects/${PROJ}/${sid}.jsonl`;
}

/** Write the transcript and force its mtime, so a rewrite looks untouched. */
function writeSource(sid: string, body: string, mtime?: Date): void {
  const p = satFile(sid);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  if (mtime) utimesSync(p, mtime, mtime);
}

/** `n` Claude entries, each with `tag` in its text (≥ 50 chars). */
function body(sid: string, n: number, tag: string, from = 0): string {
  let out = '';
  for (let i = from; i < from + n; i++) {
    out += claudeEntry(sid, i, `${tag} entry ${i} — long enough to clear the fifty character embedding floor`, { cwd: '/tmp/integrity' });
  }
  return out;
}

/**
 * One push run with a short budget; the suite never waits 120 s.
 *
 * `full: true` because the fixtures carry the ORIGINAL March mtime the defect
 * depends on — the 7-day recent window would skip them, and the real recovery
 * is exactly the hub's ≤24 h full manifest (S15).
 */
function push(): Promise<PushResult> {
  return runPush({ full: true, budgetMs: 30_000, allowFullSweep: false });
}

/** Rows the hub stored for `sid`. */
function rowsFor(sid: string): Array<{ message_id: string; message_text: string }> {
  return dbRows(hubSb.dbFile, 'SELECT message_id, message_text FROM messages WHERE session_id = ? ORDER BY message_seq', [sid]);
}

function watermark(sid: string): { last_size: number } | undefined {
  return dbRows<{ last_size: number }>(
    hubSb.dbFile, 'SELECT last_size FROM ingest_watermark WHERE transcript_path = ?', [mirrorFile(sid)],
  )[0];
}

/** `.superseded-…` siblings of a mirror file. */
function supersededSiblings(sid: string): string[] {
  const dir = join(mirrorFile(sid), '..');
  try {
    return readdirSync(dir).filter((n) => n.startsWith(`${sid}.jsonl.superseded-`));
  } catch {
    return [];
  }
}

/** Wait until the hub's ingest wrote `n` rows for `sid`. */
function waitRows(sid: string, n: number): Promise<boolean> {
  return waitFor(() => rowsFor(sid).length === n, 15_000);
}

function pushLogText(): string {
  try { return readFileSync(join(logsDir(), 'push.log'), 'utf-8'); } catch { return ''; }
}

beforeAll(async () => {
  hubSb = makeSandbox('recall-push-integrity-hub-');
  expect(resolve(hubSb.recallHome).startsWith(resolve(tmpdir()))).toBe(true);
  stagePlaceholders(hubSb.recallHome);
  createDb(hubSb);
  token = issueToken(hubSb, HOST);
  // A long sweep period: the suite drives the one sweep it needs by SIGUSR1.
  d = await startDaemon(hubSb, { env: { RECALL_HUB_SWEEP_MS: '3600000' } });

  satTmp = mkdtempSync(join(tmpdir(), 'recall-push-integrity-sat-'));
  satHome = join(satTmp, '.recall');
  satClaude = join(satTmp, 'claude');
  mkdirSync(join(satHome, 'logs'), { recursive: true });
  mkdirSync(satClaude, { recursive: true });
  mkdirSync(join(satTmp, 'codex'), { recursive: true });
  restore = _setTestRoot(satHome);
  expect(resolve(satHome).startsWith(resolve(tmpdir()))).toBe(true);
  setEnv('CLAUDE_CONFIG_DIR', satClaude);
  setEnv('CODEX_HOME', join(satTmp, 'codex'));
  setEnv('RECALL_REMOTE_ROOT', join(satTmp, 'remote'));
  writeFileSync(join(satHome, 'config.json'), JSON.stringify({
    satellite: { hubUrl: d.url, host: HOST, installedAt: new Date().toISOString() },
  }, null, 2));
  writeFileSync(join(satHome, 'satellite-token'), `${token}\n`, { mode: 0o600 });
}, 90_000);

afterAll(async () => {
  await d?.stop();
  restore?.();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  hubSb?.cleanup();
  if (satTmp) rmSync(satTmp, { recursive: true, force: true });
});

describe.skipIf(win32)('push integrity — rewrite in place (D1)', () => {
  it('(a) a rewrite that GROWS under a stable mtime is reset, not appended onto', async () => {
    const sid = randomUUID();
    const march = new Date('2026-03-19T21:32:29.000Z');
    // Both versions exceed HEAD_BYTES, so the MANIFEST head hash decides.
    // (A file whose old size is under the new head window is left to the
    // append-time prefix check — that is case (c).)
    writeSource(sid, body(sid, 30, 'v1'), march);
    expect(statSync(satFile(sid)).size).toBeGreaterThan(HEAD_BYTES);
    expect((await push()).pushed).toBe(1);
    expect(await waitRows(sid, 30)).toBe(true);
    expect(readFileSync(mirrorFile(sid))).toEqual(readFileSync(satFile(sid)));

    // The rewrite Codex Desktop 0.153.1 performed: line 1 changes, the file
    // grows, and the mtime stays at its March value.
    const rewritten = body(sid, 30, 'v2') + body(sid, 2, 'v2', 30);
    writeSource(sid, rewritten, march);
    expect(statSync(satFile(sid)).size).toBeGreaterThan(readFileSync(mirrorFile(sid)).length);

    const before = hubLogLines(hubSb).length;
    expect((await push()).pushed).toBe(1);
    expect(await waitRows(sid, 32)).toBe(true);

    const newLines = hubLogLines(hubSb).slice(before);
    expect(newLines.filter((l) => l.includes(`prefix-mismatch host=${HOST}`) && l.includes('via=head'))).toHaveLength(1);
    // Byte-for-byte, with the corrupt copy renamed aside rather than deleted.
    expect(readFileSync(mirrorFile(sid))).toEqual(readFileSync(satFile(sid)));
    expect(supersededSiblings(sid)).toHaveLength(1);
    // Exactly the fresh parse: the v1 text of entry 0 is gone, not shadowed.
    const rows = rowsFor(sid);
    expect(rows).toHaveLength(32);
    expect(rows.filter((r) => r.message_text.includes('v1'))).toHaveLength(0);
    expect(watermark(sid)?.last_size).toBe(statSync(satFile(sid)).size);
  }, 60_000);

  it('(b) a SAME-SIZE rewrite inside the first 4 KB is caught by the head hash', async () => {
    const sid = randomUUID();
    const march = new Date('2026-03-19T21:32:29.000Z');
    writeSource(sid, body(sid, 6, 'aaa'), march);
    expect((await push()).pushed).toBe(1);
    expect(await waitRows(sid, 6)).toBe(true);
    const size = statSync(satFile(sid)).size;

    // Same byte count, different bytes, same mtime: only a hash sees it.
    writeSource(sid, body(sid, 6, 'bbb'), march);
    expect(statSync(satFile(sid)).size).toBe(size);
    expect(hashFileHead(satFile(sid), size)).not.toBe(hashFileHead(mirrorFile(sid), size));

    const before = hubLogLines(hubSb).length;
    await push();
    expect(await waitFor(() => rowsFor(sid).every((r) => r.message_text.includes('bbb')), 15_000)).toBe(true);
    expect(hubLogLines(hubSb).slice(before).filter((l) => l.includes('via=head'))).toHaveLength(1);
    expect(readFileSync(mirrorFile(sid))).toEqual(readFileSync(satFile(sid)));
    expect(rowsFor(sid)).toHaveLength(6);
  }, 60_000);

  it('(c) a rewrite PAST the head window is caught at append time by the prefix hash', async () => {
    const sid = randomUUID();
    const march = new Date('2026-03-19T21:32:29.000Z');
    // ≥ 4 KB of untouched head, so the manifest head hash agrees.
    const head = body(sid, 40, 'head');
    expect(Buffer.byteLength(head)).toBeGreaterThan(HEAD_BYTES);
    writeSource(sid, head + body(sid, 4, 'tail-v1', 40), march);
    expect((await push()).pushed).toBe(1);
    expect(await waitRows(sid, 44)).toBe(true);
    const mirrorSize = statSync(mirrorFile(sid)).size;

    // Rewrite beyond the window AND grow: head matches, prefix does not.
    writeSource(sid, head + body(sid, 6, 'tail-v2', 40), march);
    expect(statSync(satFile(sid)).size).toBeGreaterThan(mirrorSize);
    expect(hashFileHead(satFile(sid), HEAD_BYTES)).toBe(hashFileHead(mirrorFile(sid), HEAD_BYTES));
    expect(hashFilePrefix(satFile(sid), mirrorSize)).not.toBe(hashFilePrefix(mirrorFile(sid), mirrorSize));

    const before = hubLogLines(hubSb).length;
    expect((await push()).pushed).toBe(1);
    expect(await waitRows(sid, 46)).toBe(true);

    const newLines = hubLogLines(hubSb).slice(before);
    expect(newLines.filter((l) => l.includes('via=prefix'))).toHaveLength(1);
    expect(newLines.filter((l) => l.includes('via=head'))).toHaveLength(0);
    expect(readFileSync(mirrorFile(sid))).toEqual(readFileSync(satFile(sid)));
    expect(rowsFor(sid).filter((r) => r.message_text.includes('tail-v1'))).toHaveLength(0);
    expect(supersededSiblings(sid)).toHaveLength(1);
  }, 60_000);

  it('(d) an OLD client — no `head`, no `prefix` — still resumes exactly as before', async () => {
    // 0.4.0-sat.2 stays on the Linux laptop: both fields are optional and
    // additive, so the hub must not demand them (no WIRE_VERSION bump).
    const sid = randomUUID();
    const rel = relOf(sid);
    const first = body(sid, 3, 'old-client');
    const second = body(sid, 2, 'old-client', 3);

    const put = async (offset: number, chunk: string, final: boolean): Promise<number> => {
      const r = await req(d.url, {
        method: 'PUT',
        path: appendPath('claude', rel, offset),
        headers: authHeaders(token, {
          'x-recall-meta': encodeMeta({ cwd: '/tmp/integrity', ...(final ? { final: true } : {}) }),
          'content-type': 'application/octet-stream',
        }),
        body: chunk,
      });
      return r.status;
    };

    const manifest = async (size: number): Promise<{ offset: number; reset?: true }> => {
      const r = await req(d.url, {
        method: 'POST',
        path: '/v1/push/manifest',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        // No `head` key at all — an old client's exact body.
        body: JSON.stringify({ vendor: 'claude', full: false, files: [{ path: rel, size, mtime: Date.now() }] }),
      });
      expect(r.status).toBe(200);
      return r.json().files[0];
    };

    const firstBytes = Buffer.byteLength(first);
    const bothBytes = firstBytes + Buffer.byteLength(second);
    expect(await manifest(firstBytes)).toEqual({ path: rel, offset: 0 });
    expect(await put(0, first, false)).toBe(200);
    // The resume answer is the mirror's size, with no reset.
    expect(await manifest(bothBytes)).toEqual({ path: rel, offset: firstBytes });
    expect(await put(firstBytes, second, true)).toBe(200);
    expect(readFileSync(mirrorFile(sid), 'utf-8')).toBe(first + second);
    expect(await waitRows(sid, 5)).toBe(true);
  }, 60_000);
});

describe.skipIf(win32)('hub refusal surfacing (D5)', () => {
  it('(e) a refused push is counted on the host record and reported back in the manifest reply', async () => {
    const sid = randomUUID();
    // The collision: provenance for this id already points OUTSIDE the host's
    // mirror, so the hub must refuse rather than merge (S11).
    const foreign = '/home/other-machine/.claude/projects/-p/elsewhere.jsonl';
    const db = new Database(hubSb.dbFile);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO session_provenance (session_id, vendor, kind, transcript_path, updated_at)
         VALUES (?, 'claude', 'root', ?, ?)`,
      ).run(sid, foreign, Date.now());
    } finally { db.close(); }

    writeSource(sid, body(sid, 4, 'refused'));
    await push();
    expect(await waitFor(() => hubLogLines(hubSb).some((l) => l.includes(`session-id collision host=${HOST} sid=${sid}`)), 15_000)).toBe(true);
    // Refused means NOT indexed: no rows, no watermark.
    expect(rowsFor(sid)).toHaveLength(0);
    const record = hostRecords(hubSb)[HOST]!;
    expect(record.refusedCollisions).toBeGreaterThanOrEqual(1);
    expect((record as { refusedRecent?: string[] }).refusedRecent).toContain(sid);

    // The next run's manifest reply carries the host's own refusal record —
    // the satellite's ONLY channel for it — and the run logs one line.
    const beforeLines = pushLogText().split('\n').length;
    const again = await push();
    expect(again.refused?.count).toBeGreaterThanOrEqual(1);
    expect(again.refused?.recent).toContain(sid);
    // Exactly ONE line for that run, however many manifests it sent.
    const logged = pushLogText().split('\n').slice(beforeLines - 1).filter((l) => l.includes('hub-refused'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`host=${HOST}`);
    expect(logged[0]).toContain(sid);

    // And the doctor probe reads it from that same reply.
    const pending = await computePendingBytes();
    expect(pending.refused?.count).toBeGreaterThanOrEqual(1);
    expect(pending.refused?.recent).toContain(sid);
  }, 60_000);
});

describe.skipIf(win32)('mirror sweep', () => {
  it('never ingests a `.superseded-` copy — the glob is `*.jsonl`', async () => {
    const dir = join(hubSb.remote, HOST, 'claude', 'projects', PROJ);
    const supersededNames = readdirSync(dir).filter((n) => n.includes('.superseded-'));
    expect(supersededNames.length).toBeGreaterThan(0);

    // Drive a real sweep over the mirror, then look for any trace of them.
    const before = hubLogLines(hubSb).length;
    process.kill(d.pid, 'SIGUSR1');
    expect(await waitFor(() => hubLogLines(hubSb).slice(before).some((l) => l.includes('sweep reason=SIGUSR1')), 20_000)).toBe(true);

    for (const name of supersededNames) {
      expect(name.endsWith('.jsonl')).toBe(false);
      const abs = join(dir, name);
      expect(existsSync(abs)).toBe(true);
      expect(dbRows(hubSb.dbFile, 'SELECT 1 FROM ingest_watermark WHERE transcript_path = ?', [abs])).toHaveLength(0);
    }
  }, 60_000);
});
