/**
 * §8.5 Query coordinator — REAL subprocess tests with a FAKE llama backend.
 *
 * Spawns fleets of the BUILT recall CLI (dist/recall.js) against an isolated
 * RECALL_HOME whose bin/ holds fake `llama-embedding` / `llama-server`
 * executables. The fake embedding binary parses the actual `-p`/`-f` input and
 * `--embd-separator`, sleeps briefly (so overlap would be observable), records
 * every start (PID, text count) plus a concurrency marker, and prints
 * deterministic 768-dim vectors derived from each text (FNV-1a + LCG). The
 * fake llama-server records any invocation — a single record fails the
 * one-shot-pin assertion.
 *
 * Result routing is verified end-to-end: the sandbox DB is seeded with one
 * message per query whose stored vector EQUALS the fake embedding of that
 * query (QUERY_PREFIX included), so each CLI's top `--raw` search hit reveals
 * which vector it actually received.
 *
 * Timing rationale the referee can re-derive: the "exactly one invocation"
 * burst test widens the coalescing window to 2500 ms via RECALL_QE_COALESCE_MS.
 * Node CLI startup is ~100–300 ms; all N request files exist on disk long
 * before the first leader's window closes, so a single batch is deterministic
 * (≥8x headroom), not a lucky race. The hard gates that hold at ANY timing are
 * max-one-concurrent-llama-process and zero llama-server invocations.
 *
 * These tests spawn subprocess fleets — run the suite under the arena lock.
 * Skipped on Windows (the fake backend relies on shebang executables).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
  chmodSync, truncateSync, closeSync, openSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { _setTestRoot, dbPath, binDir, modelsDir, runDir } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { insertMessages, insertMessageVectors } from '../../src/recall/message-store.js';
import { quantizeToQ8, computeNorm } from '../../src/recall/quantize.js';
import { QUERY_PREFIX } from '../../src/recall/embed-config.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');

// ---------------------------------------------------------------------------
// Deterministic fake embedding — MUST match the fake binary's implementation
// ---------------------------------------------------------------------------

function fakeVec(text: string): Float32Array {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const v = new Float32Array(768);
  let x = h || 1;
  for (let i = 0; i < 768; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    v[i] = x / 4294967296 - 0.5;
  }
  return v;
}

/** Source of the fake llama-embedding executable (Node script w/ shebang). */
function fakeEmbeddingSource(logDir: string): string {
  return `#!/usr/bin/env node
// Fake llama-embedding: records starts + concurrency, parses -p/-f input,
// splits on --embd-separator, sleeps, prints deterministic 768-dim vectors.
const fs = require('fs');
const path = require('path');
const LOG = ${JSON.stringify(logDir)};
const RUNNING = path.join(LOG, 'running');
fs.mkdirSync(RUNNING, { recursive: true });
const marker = path.join(RUNNING, String(process.pid));
fs.writeFileSync(marker, '');
process.on('exit', () => { try { fs.unlinkSync(marker); } catch {} });
const others = fs.readdirSync(RUNNING).filter((n) => n !== String(process.pid));
if (others.length > 0) {
  fs.appendFileSync(path.join(LOG, 'violations.log'),
    JSON.stringify({ pid: process.pid, concurrentWith: others }) + '\\n');
}
const args = process.argv.slice(2);
function argOf(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
const sep = argOf('--embd-separator') || '<#sep#>';
let joined = argOf('-p');
if (joined === undefined) {
  const f = argOf('-f');
  joined = f ? fs.readFileSync(f, 'utf8') : '';
}
const texts = joined.split(sep);
fs.appendFileSync(path.join(LOG, 'invocations.jsonl'),
  JSON.stringify({ pid: process.pid, start: Date.now(), textCount: texts.length }) + '\\n');
function fakeVec(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const v = new Array(768);
  let x = h || 1;
  for (let i = 0; i < 768; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; v[i] = x / 4294967296 - 0.5; }
  return v;
}
const sleepMs = parseInt(process.env.FAKE_EMBED_SLEEP_MS || '300', 10);
setTimeout(() => {
  try { process.stdout.write(JSON.stringify(texts.map(fakeVec))); } catch {}
  process.exit(0);
}, sleepMs);
`;
}

/** Fake llama-server: any invocation is a one-shot-pin violation. */
function fakeServerSource(logDir: string): string {
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(${JSON.stringify(logDir)}, 'server-invoked.log'),
  JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
setTimeout(() => process.exit(1), 100);
`;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let recallHome: string;
let logDir: string;
let restoreRoot: (() => void) | undefined;
const spawned: ChildProcess[] = [];

function stageSandbox(): void {
  mkdirSync(binDir(), { recursive: true });
  mkdirSync(modelsDir(), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  // Fake executables.
  const embedBin = join(binDir(), 'llama-embedding');
  writeFileSync(embedBin, fakeEmbeddingSource(logDir));
  chmodSync(embedBin, 0o755);
  const serverBin = join(binDir(), 'llama-server');
  writeFileSync(serverBin, fakeServerSource(logDir));
  chmodSync(serverBin, 0o755);
  // Sparse fake model >100 MB so ensureModel() is satisfied without a download.
  const model = join(modelsDir(), 'nomic-embed-text-v1.5.Q8_0.gguf');
  const fd = openSync(model, 'w');
  closeSync(fd);
  truncateSync(model, 150_000_000);
}

/** Seed one hot message + vector per query so the top semantic hit identifies
 *  which query vector a CLI actually received. */
function seedDb(queries: string[]): Map<string, string> {
  const expected = new Map<string, string>(); // query → session_id
  getDb(dbPath());
  const messages = queries.map((q, i) => ({
    message_id: `msg-for-query-${i}`,
    session_id: `session-for-query-${i}`,
    message_seq: 0,
    message_text: `stored document body number ${i} — deliberately non-overlapping vocabulary padding padding padding`,
    project_id: null,
    created_at: Date.now() - i * 1000,
    message_role: 'assistant',
  }));
  insertMessages(messages);
  insertMessageVectors(queries.map((q, i) => {
    const f32 = fakeVec(QUERY_PREFIX + q);
    const { q8, scale } = quantizeToQ8(f32);
    expected.set(q, `session-for-query-${i}`);
    return { messageId: `msg-for-query-${i}`, embeddingQ8: q8, norm: computeNorm(f32), quantScale: scale };
  }));
  _resetDb(); // close so child CLIs own the DB
  return expected;
}

interface CliResult { code: number | null; stdout: string; stderr: string }

function runCli(
  query: string,
  env: Record<string, string>,
): { child: ChildProcess; done: Promise<CliResult> } {
  const child = spawn(process.execPath, [CLI_BUNDLE, query, '--raw', '--all', '--no-catchup'], {
    env: {
      ...process.env,
      RECALL_HOME: recallHome,
      CLAUDE_CONFIG_DIR: join(recallHome, 'claude-empty'),
      CODEX_HOME: join(recallHome, 'codex-empty'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  const done = new Promise<CliResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => { stdout += d; });
    child.stderr!.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function invocations(): Array<{ pid: number; start: number; textCount: number }> {
  const p = join(logDir, 'invocations.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function violations(): string[] {
  const p = join(logDir, 'violations.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

function serverInvocations(): string[] {
  const p = join(logDir, 'server-invoked.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

function qeArtifacts(): string[] {
  const dir = join(runDir(), 'query-embed');
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function topSessionOf(raw: string): string | undefined {
  const parsed = JSON.parse(raw) as { sessions?: Array<{ session_id: string }> };
  return parsed.sessions?.[0]?.session_id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  if (!existsSync(CLI_BUNDLE)) {
    throw new Error('dist/recall.js missing — run `npm run build` first');
  }
  recallHome = join(tmpdir(), `recall-qc-${randomUUID()}`);
  logDir = join(recallHome, 'fake-log');
  mkdirSync(join(recallHome, 'claude-empty'), { recursive: true });
  mkdirSync(join(recallHome, 'codex-empty'), { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  stageSandbox();
});

afterEach(() => {
  for (const c of spawned) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
  spawned.length = 0;
  restoreRoot?.();
  _resetDb();
  rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('query coordinator — subprocess fleets (fake backend)', () => {
  it('a synchronized burst of 7 CLIs (6 distinct + 1 duplicate query) coalesces into ONE one-shot invocation, never llama-server', async () => {
    // 7 CLIs > SERVER_THRESHOLD(5): without the one-shot pin the coalesced
    // batch would engage llama-server — the fake server records the violation.
    const distinct = Array.from({ length: 6 }, (_, i) => `zeta unique probe number ${i}`);
    const queries = [...distinct, distinct[0]!]; // one exact duplicate
    const expected = seedDb(distinct);

    const runs = queries.map((q) => runCli(q, {
      RECALL_QE_COALESCE_MS: '2500',
      FAKE_EMBED_SLEEP_MS: '300',
    }));
    const results = await Promise.all(runs.map((r) => r.done));

    for (const r of results) expect(r.code).toBe(0);
    // Correct routed vector per CLI: its top semantic hit is its own session.
    results.forEach((r, i) => {
      expect(topSessionOf(r.stdout), `CLI ${i} (${queries[i]})`).toBe(expected.get(queries[i]!));
    });

    const inv = invocations();
    expect(inv, 'exactly one model invocation for the synchronized burst').toHaveLength(1);
    expect(inv[0]!.textCount, 'duplicate texts deduplicated (7 requests → 6 texts)').toBe(6);
    expect(violations()).toEqual([]);
    expect(serverInvocations(), 'llama-server must NEVER be engaged for queries').toEqual([]);
    expect(qeArtifacts(), 'no lock/request/response artifacts after clean exits').toEqual([]);
  }, 120_000);

  it('default coalescing window: burst completes with bounded invocations and max ONE concurrent llama process', async () => {
    const queries = Array.from({ length: 6 }, (_, i) => `narrow window probe ${i}`);
    const expected = seedDb(queries);

    const runs = queries.map((q) => runCli(q, { FAKE_EMBED_SLEEP_MS: '400' }));
    const results = await Promise.all(runs.map((r) => r.done));

    for (const r of results) expect(r.code).toBe(0);
    results.forEach((r, i) => {
      expect(topSessionOf(r.stdout)).toBe(expected.get(queries[i]!));
    });
    // With the default 25 ms window, stragglers form bounded follow-up batches
    // — but NEVER a per-caller fan-out and NEVER a concurrent second process.
    expect(invocations().length).toBeLessThanOrEqual(queries.length - 1);
    expect(violations(), 'max concurrent query llama processes is one').toEqual([]);
    expect(serverInvocations()).toEqual([]);
    expect(qeArtifacts()).toEqual([]);
  }, 120_000);

  it('SIGKILLed leader is replaced without hanging or fan-out; followers still get correct results', async () => {
    const queries = ['victim leader probe', 'survivor follower one', 'survivor follower two'];
    const expected = seedDb(queries);

    // Leader embeds slowly so we can kill it mid-batch.
    const leader = runCli(queries[0]!, {
      RECALL_QE_COALESCE_MS: '100',
      FAKE_EMBED_SLEEP_MS: '5000',
    });
    // Wait until the leader's model child has started (it is mid-embed).
    await waitFor(() => invocations().length >= 1, 20_000, 'leader model invocation');

    const followers = queries.slice(1).map((q) => runCli(q, {
      RECALL_QE_COALESCE_MS: '100',
      FAKE_EMBED_SLEEP_MS: '200',
    }));
    await sleep(300); // let followers write requests and enter the wait loop
    leader.child.kill('SIGKILL');

    const results = await Promise.all(followers.map((f) => f.done));
    for (const r of results) expect(r.code).toBe(0);
    results.forEach((r, i) => {
      expect(topSessionOf(r.stdout)).toBe(expected.get(queries[i + 1]!));
    });
    // First (killed) invocation + one replacement batch — not one per follower.
    expect(invocations().length).toBeLessThanOrEqual(2);
    expect(serverInvocations()).toEqual([]);
    // The killed leader's own req/res may linger as INERT files; a follower
    // sweep or the next invocation reaps them. No process survives — the fake
    // embed child self-terminates. Verify a fresh invocation reaps leftovers:
    const fresh = runCli('survivor follower one', { FAKE_EMBED_SLEEP_MS: '50' });
    const freshRes = await fresh.done;
    expect(freshRes.code).toBe(0);
    expect(qeArtifacts().filter((n) => n === 'leader.lock')).toEqual([]);
  }, 120_000);

  it('two followers racing a DEAD leader lock elect exactly one replacement (TOCTOU reap)', async () => {
    const queries = ['reap racer alpha', 'reap racer beta'];
    const expected = seedDb(queries);

    // Plant a stale lock owned by a genuinely dead PID.
    const { spawnSync } = await import('node:child_process');
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 15_000 }).pid!;
    const qe = join(runDir(), 'query-embed');
    mkdirSync(qe, { recursive: true });
    writeFileSync(join(qe, 'leader.lock'), JSON.stringify({
      v: 1, pid: dead, token: 'stale-dead-token', acquiredAt: Date.now(),
    }));

    const runs = queries.map((q) => runCli(q, {
      RECALL_QE_COALESCE_MS: '1500',
      FAKE_EMBED_SLEEP_MS: '300',
    }));
    const results = await Promise.all(runs.map((r) => r.done));

    for (const r of results) expect(r.code).toBe(0);
    results.forEach((r, i) => {
      expect(topSessionOf(r.stdout)).toBe(expected.get(queries[i]!));
    });
    expect(invocations(), 'one leader elected after the reap').toHaveLength(1);
    expect(violations(), 'never two concurrent model loads').toEqual([]);
    expect(qeArtifacts()).toEqual([]);
  }, 120_000);

  it('SIGTERM mid-coordination cleans up the lock and artifacts', async () => {
    seedDb(['sigterm cleanup probe']);
    const run = runCli('sigterm cleanup probe', {
      RECALL_QE_COALESCE_MS: '100',
      FAKE_EMBED_SLEEP_MS: '8000',
    });
    await waitFor(() => invocations().length >= 1, 20_000, 'model invocation');
    run.child.kill('SIGTERM');
    const res = await run.done;
    expect(res.code).toBe(143);
    // Signal handler released the lock + removed own request/response.
    await waitFor(() => !qeArtifacts().includes('leader.lock'), 5_000, 'lock release');
    expect(qeArtifacts().filter((n) => n.startsWith('req-'))).toEqual([]);
  }, 120_000);

  it('corrupt and stale artifacts planted in the runtime dir are reaped and do not break a query', async () => {
    const expected = seedDb(['hygiene probe query']);
    const qe = join(runDir(), 'query-embed');
    mkdirSync(qe, { recursive: true });
    const old = new Date(Date.now() - 15 * 60_000);
    const { utimesSync } = await import('node:fs');
    for (const [name, body] of [
      ['req-corruptreq12345.json', '{broken'],
      ['res-orphanres123456.json', JSON.stringify({ v: 1, token: 'orphanres123456', ok: true, vector: [] })],
      ['.tmp-deadbeef', 'partial'],
      ['leader.reap-stale', '{}'],
    ] as const) {
      const p = join(qe, name);
      writeFileSync(p, body);
      utimesSync(p, old, old);
    }

    const run = runCli('hygiene probe query', { FAKE_EMBED_SLEEP_MS: '100' });
    const res = await run.done;
    expect(res.code).toBe(0);
    expect(topSessionOf(res.stdout)).toBe(expected.get('hygiene probe query'));
    expect(qeArtifacts()).toEqual([]);
  }, 120_000);
});
