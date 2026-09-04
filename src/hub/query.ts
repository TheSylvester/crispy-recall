/**
 * Proxied queries (spec §2.3 "Query rules", D3, S1, S9, S10, S14).
 *
 * The hub executes a satellite query by SPAWNING `process.execPath
 * [recall.js, ...argv]` with array args (no shell), never in-process:
 * recall.ts has no importable seam and its query path installs process
 * signal handlers. Output stays byte-identical, which the SKILL.md contract
 * needs; the exit code crosses the wire in the JSON body.
 *
 * @module hub/query
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { binDir } from '../paths.js';
import { normalizePath } from '../url-path-resolver.js';
import {
  KEY_RE, MAX_ARGV, MAX_ARGV_STRING, QUERY_FLAG_ALLOWLIST, REJECTED_POSITIONALS,
  type QueryRequest, type QueryResponse,
} from './protocol.js';

/**
 * S14: 1 until the `_stem` race is fixed, then 4. The `_stem`/`_stem_vocab`
 * scratch tables now live in each connection's `temp.` schema (db.ts
 * `ensureStemScratch`), so two processes can never interleave — proven by
 * test/integration/hub-stem-race.test.ts at 0/2,000 wrong stems.
 */
export const HUB_QUERY_CONCURRENCY = 4;
/** Waiting queries beyond this → 503. */
export const HUB_QUERY_QUEUE_DEPTH = 32;
/** SIGKILL after this → 504. */
export const HUB_QUERY_TIMEOUT_MS = 120_000;
/** Ingest-queue drain wait before a query; on timeout proceed + `X-Recall-Stale: 1`. */
export const HUB_DRAIN_CAP_MS = 10_000;

/** Flags whose next token is a value, never a positional. */
const VALUE_FLAGS = new Set(['--limit', '--offset', '--since', '--until']);

export function hubCliPath(): string {
  return process.env['RECALL_HUB_CLI'] ?? join(binDir(), 'recall.js');
}

/** Body validation for `POST /v1/query`. */
export function validateQueryBody(raw: unknown): { ok: true; req: QueryRequest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  const argv = b['argv'];
  if (!Array.isArray(argv)) return { ok: false, reason: 'argv must be an array' };
  if (argv.length > MAX_ARGV) return { ok: false, reason: `argv exceeds ${MAX_ARGV} strings` };
  for (const a of argv) {
    if (typeof a !== 'string') return { ok: false, reason: 'argv must contain only strings' };
    if (Buffer.byteLength(a, 'utf8') > MAX_ARGV_STRING) return { ok: false, reason: `argv string exceeds ${MAX_ARGV_STRING} bytes` };
    if (a.includes('\0')) return { ok: false, reason: 'argv string contains NUL' };
  }
  const cwd = b['cwd'];
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, reason: 'cwd must be a non-empty string' };
  if (cwd.startsWith('-')) return { ok: false, reason: 'cwd must not begin with -' };
  if (cwd.includes('\0')) return { ok: false, reason: 'cwd contains NUL' };
  const key = b['key'];
  if (key !== undefined && (typeof key !== 'string' || !KEY_RE.test(key))) return { ok: false, reason: 'key is not a project key' };
  const host = b['host'];
  if (host !== undefined && typeof host !== 'string') return { ok: false, reason: 'host must be a string' };
  return {
    ok: true,
    req: {
      argv: argv as string[], cwd,
      ...(typeof key === 'string' ? { key } : {}),
      ...(typeof host === 'string' ? { host } : {}),
    },
  };
}

/**
 * Query rules: strip `--context <n>`; 400 on any other `--` token outside the
 * allowlist, on a rejected positional, and on `--project`/`--project-key`.
 * The hub is the SOLE writer of scope: without `--all` it appends
 * `--project-key <key> --project <normalizePath(cwd)>` (only `--project`
 * when `key` is absent); always `--no-catchup`.
 */
export function buildHubArgv(req: QueryRequest): { ok: true; argv: string[] } | { ok: false; reason: string } {
  const out: string[] = [];
  let expectValue = false;
  for (let i = 0; i < req.argv.length; i++) {
    const a = req.argv[i]!;
    if (expectValue) { out.push(a); expectValue = false; continue; }
    if (a === '--context') { i++; continue; }
    if (a === '--project' || a === '--project-key') return { ok: false, reason: '--project must be resolved on the satellite' };
    if (a.startsWith('--')) {
      if (!QUERY_FLAG_ALLOWLIST.has(a)) return { ok: false, reason: `flag ${a} is not allowed on a proxied query` };
      out.push(a);
      if (VALUE_FLAGS.has(a)) expectValue = true;
      continue;
    }
    if (REJECTED_POSITIONALS.has(a)) return { ok: false, reason: `"${a}" is a command, not a query` };
    out.push(a);
  }
  if (!out.includes('--all')) {
    if (req.key) out.push('--project-key', req.key);
    out.push('--project', normalizePath(req.cwd));
  }
  out.push('--no-catchup');
  return { ok: true, argv: out };
}

export type QueryRun =
  | { kind: 'ok'; body: QueryResponse }
  | { kind: 'busy' }
  | { kind: 'timeout' };

export interface QueryRunnerOptions {
  concurrency?: number;
  depth?: number;
  timeoutMs?: number;
  cli?: () => string;
}

/** Bounded-concurrency spawner with a bounded wait queue. */
export class QueryRunner {
  private running = 0;
  private waiting: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly depth: number;
  private readonly timeoutMs: number;
  private readonly cli: () => string;

  constructor(opts: QueryRunnerOptions = {}) {
    this.concurrency = opts.concurrency ?? HUB_QUERY_CONCURRENCY;
    this.depth = opts.depth ?? HUB_QUERY_QUEUE_DEPTH;
    this.timeoutMs = opts.timeoutMs ?? HUB_QUERY_TIMEOUT_MS;
    this.cli = opts.cli ?? hubCliPath;
  }

  get active(): number { return this.running; }
  get queued(): number { return this.waiting.length; }

  async run(argv: string[]): Promise<QueryRun> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.depth) return { kind: 'busy' };
      await new Promise<void>((resolve) => { this.waiting.push(resolve); });
    }
    this.running++;
    try {
      return await this.spawnOnce(argv);
    } finally {
      this.running--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  private spawnOnce(argv: string[]): Promise<QueryRun> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child;
      try {
        child = spawn(process.execPath, [this.cli(), ...argv], {
          cwd: homedir(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (e) {
        resolve({ kind: 'ok', body: { stdout: '', stderr: `recall hub: spawn failed: ${(e as Error).message}\n`, exit: 1 } });
        return;
      }
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => { stdout += c; });
      child.stderr!.on('data', (c: string) => { stderr += c; });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve({ kind: 'timeout' });
      }, this.timeoutMs);
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'ok', body: { stdout, stderr: stderr + `recall hub: spawn failed: ${e.message}\n`, exit: 1 } });
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'ok', body: { stdout, stderr, exit: code ?? (signal ? 128 : 1) } });
      });
    });
  }
}
