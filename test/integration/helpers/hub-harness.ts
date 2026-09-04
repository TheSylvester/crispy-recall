/**
 * Shared harness for the hub suites: sandboxed roots, a spawned daemon on an
 * ephemeral port, a tiny HTTP client, and JSONL fixture writers.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { encodeMeta, type AppendMeta } from '../../../src/hub/protocol.js';

export const ROOT = join(__dirname, '..', '..', '..');
export const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');
export const NODE = process.execPath;
export const MODEL_FILENAME = 'nomic-embed-text-v1.5.Q8_0.gguf';

export interface Sandbox {
  tmp: string;
  recallHome: string;
  remote: string;
  claude: string;
  codex: string;
  dbFile: string;
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeSandbox(prefix = 'recall-hub-'): Sandbox {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const recallHome = join(tmp, '.recall');
  const remote = join(recallHome, 'remote');
  const claude = join(tmp, 'claude');
  const codex = join(tmp, 'codex');
  for (const d of [join(recallHome, 'bin'), join(recallHome, 'models'), claude, codex]) mkdirSync(d, { recursive: true });
  return {
    tmp, recallHome, remote, claude, codex, dbFile: join(recallHome, 'recall.db'),
    env: (extra = {}) => ({
      ...process.env,
      RECALL_HOME: recallHome,
      RECALL_REMOTE_ROOT: remote,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      RECALL_LOG_LEVEL: 'error',
      RECALL_HUB_CLI: CLI_BUNDLE,
      ...extra,
    }),
    cleanup: () => { rmSync(tmp, { recursive: true, force: true }); },
  };
}

/** Placeholder binary + model: the daemon's preflight only checks existence. */
export function stagePlaceholders(recallHome: string): void {
  mkdirSync(join(recallHome, 'bin'), { recursive: true });
  mkdirSync(join(recallHome, 'models'), { recursive: true });
  writeFileSync(join(recallHome, 'bin', 'llama-embedding'), '');
  writeFileSync(join(recallHome, 'models', MODEL_FILENAME), '');
}

/** Deterministic fake llama-embedding (copied from project-key-cli.test.ts):
 *  every spawned query embeds through it, so no query can hang on a backend. */
export function stageFakeBackend(recallHome: string): void {
  const bin = join(recallHome, 'bin');
  const models = join(recallHome, 'models');
  mkdirSync(bin, { recursive: true });
  mkdirSync(models, { recursive: true });
  const embedBin = join(bin, 'llama-embedding');
  writeFileSync(embedBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
function argOf(f){const i=args.indexOf(f);return i>=0?args[i+1]:undefined;}
const fs = require('fs');
const sep = argOf('--embd-separator') || '<#sep#>';
let joined = argOf('-p'); if (joined === undefined) { const f = argOf('-f'); joined = f ? fs.readFileSync(f,'utf8') : ''; }
const texts = joined.split(sep);
process.stdout.write(JSON.stringify(texts.map(() => Array.from({length:768},(_,i)=>(i%7)/7-0.5))));
`);
  chmodSync(embedBin, 0o755);
  const serverBin = join(bin, 'llama-server');
  writeFileSync(serverBin, '#!/usr/bin/env node\nprocess.exit(1);\n');
  chmodSync(serverBin, 0o755);
  const model = join(models, MODEL_FILENAME);
  const fd = openSync(model, 'w'); closeSync(fd);
  truncateSync(model, 150_000_000);
}

export interface CliResult { status: number | null; stdout: string; stderr: string }

export function cli(sb: Sandbox, args: string[], opts?: { env?: Record<string, string>; cwd?: string; input?: string }): CliResult {
  const r = spawnSync(NODE, [CLI_BUNDLE, ...args], {
    env: sb.env(opts?.env), cwd: opts?.cwd ?? sb.tmp, encoding: 'utf-8', timeout: 60_000,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Create the sandbox DB (fresh schema, every marker present) through the CLI. */
export function createDb(sb: Sandbox): void {
  const r = cli(sb, ['--list', '--no-catchup']);
  if (!existsSync(sb.dbFile)) throw new Error(`createDb: no DB after --list (status ${r.status}): ${r.stderr}`);
}

export function issueToken(sb: Sandbox, host: string): string {
  const r = cli(sb, ['hub', 'token', '--host', host]);
  const line = r.stdout.split('\n').find((l) => /^[0-9a-f]{64}$/.test(l.trim()));
  if (!line) throw new Error(`issueToken: no token line (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  return line.trim();
}

export function readHubJson(sb: Sandbox): { pid: number; port: number; bind: string; lockToken: string } | null {
  try { return JSON.parse(readFileSync(join(sb.recallHome, 'run', 'hub.json'), 'utf-8')); } catch { return null; }
}

export interface Daemon {
  proc: ChildProcess;
  pid: number;
  port: number;
  url: string;
  output(): string;
  stop(): Promise<number | null>;
}

export async function startDaemon(sb: Sandbox, opts?: { args?: string[]; env?: Record<string, string> }): Promise<Daemon> {
  const proc = spawn(NODE, [CLI_BUNDLE, 'hub', 'serve', '--bind', '127.0.0.1', '--port', '0', ...(opts?.args ?? [])], {
    env: sb.env(opts?.env), cwd: sb.tmp, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (c) => { out += String(c); });
  proc.stderr!.on('data', (c) => { out += String(c); });
  let exited: number | null | undefined;
  proc.on('exit', (code) => { exited = code; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`daemon exited early (${exited}): ${out}`);
    const j = readHubJson(sb);
    if (j && j.pid === proc.pid && j.port > 0) {
      return {
        proc, pid: proc.pid!, port: j.port, url: `http://127.0.0.1:${j.port}`,
        output: () => out,
        stop: () => new Promise((resolve) => {
          if (exited !== undefined) { resolve(exited); return; }
          const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
          proc.once('exit', (code) => { clearTimeout(t); resolve(code); });
          proc.kill('SIGTERM');
        }),
      };
    }
    await sleep(50);
  }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  throw new Error(`daemon did not publish a port: ${out}`);
}

export interface Resp {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json<T = any>(): T;
}

export interface ReqOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send chunked (no Content-Length) — for the 411 case. */
  chunked?: boolean;
  /** Declare a Content-Length larger than the body and end early — for the 400 case. */
  declareLength?: number;
}

export function req(url: string, o: ReqOptions): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = o.body === undefined ? undefined : (typeof o.body === 'string' ? Buffer.from(o.body, 'utf8') : o.body);
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (body !== undefined && !o.chunked && o.declareLength === undefined) headers['content-length'] = String(body.length);
    if (o.declareLength !== undefined) headers['content-length'] = String(o.declareLength);
    if (o.chunked) headers['transfer-encoding'] = 'chunked';
    const r = httpRequest({
      hostname: u.hostname, port: Number(u.port), path: o.path, method: o.method, headers,
    });
    if (o.declareLength === undefined) {
      r.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
    }
    if (o.declareLength !== undefined) {
      // Deliberate early end: send what we have, then drop the socket. The
      // server is expected to answer BEFORE the drop (413 from the header).
      // The fallback status is -1, never a synthetic 400: a test that asserts
      // a status here must be reading a real server response, not our own
      // socket teardown. (For the half-close truncation case use `rawPut`.)
      let settled = false;
      const settle = (r2: Resp): void => { if (!settled) { settled = true; resolve(r2); } };
      r.on('error', () => settle({ status: -1, headers: {}, text: '', json: () => ({} as never) }));
      r.on('close', () => settle({ status: -1, headers: {}, text: '', json: () => ({} as never) }));
      r.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          settle({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
      if (body !== undefined) r.write(body);
      setTimeout(() => r.destroy(), 150);
      return;
    }
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/**
 * Raw-socket PUT with a Content-Length the body deliberately does not reach,
 * then a HALF-CLOSE (`end()`, never `destroy()`), so the server sees the
 * truncation and its answer is still deliverable on the socket. Returns the
 * raw response bytes (empty string when the server answered nothing).
 */
export function rawPutShortBody(
  port: number,
  path: string,
  headers: Record<string, string>,
  declaredLength: number,
  partial: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { raw += c; });
    socket.on('error', reject);
    socket.on('close', () => resolve(raw));
    socket.on('connect', () => {
      const lines = [
        `PUT ${path} HTTP/1.1`,
        'host: 127.0.0.1',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        `content-length: ${declaredLength}`,
        '', '',
      ];
      socket.write(lines.join('\r\n'));
      socket.write(partial);
      socket.end(); // half-close: FIN only, the response can still arrive
    });
    setTimeout(() => { socket.destroy(); resolve(raw); }, 10_000).unref();
  });
}

export function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { 'x-recall-wire': '1', authorization: `Bearer ${token}`, ...(extra ?? {}) };
}

export function metaHeader(m: AppendMeta): string {
  return encodeMeta(m);
}

export function appendPath(vendor: string, rel: string, offset: number): string {
  return `/v1/push/append?vendor=${encodeURIComponent(vendor)}&path=${encodeURIComponent(rel)}&offset=${offset}`;
}

/** One Claude transcript entry (JSON line + newline). ≥ 50 chars of text. */
export function claudeEntry(sid: string, i: number, text: string, opts?: { cwd?: string; uuid?: string; role?: 'user' | 'assistant' }): string {
  const role = opts?.role ?? (i % 2 === 0 ? 'user' : 'assistant');
  return JSON.stringify({
    type: role,
    uuid: opts?.uuid ?? `${sid}-msg-${i}`,
    parentUuid: i === 0 ? null : `${sid}-msg-${i - 1}`,
    sessionId: sid,
    cwd: opts?.cwd ?? '/home/x/proj',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    message: { role, content: text },
  }) + '\n';
}

/** A Codex rollout body (session_meta + one user/assistant pair). */
export function codexRollout(sid: string, text: string, cwd = '/home/u/proj'): string {
  const rows = [
    { timestamp: '2026-02-07T20:34:15.000Z', type: 'session_meta', payload: { id: sid, cwd, cli_version: '0.92.0' } },
    { timestamp: '2026-02-07T20:34:17.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { timestamp: '2026-02-07T20:34:21.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply: ${text}` }] } },
  ];
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function dbRows<T = Record<string, unknown>>(dbFile: string, sql: string, params: unknown[] = []): T[] {
  const d = new Database(dbFile, { readonly: true, fileMustExist: true });
  try { return d.prepare(sql).all(...params) as T[]; } finally { d.close(); }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(pred: () => boolean, timeoutMs = 10_000, everyMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(everyMs);
  }
  return pred();
}

/** The hub.log lines of a sandbox. */
export function hubLogLines(sb: Sandbox): string[] {
  try { return readFileSync(join(sb.recallHome, 'logs', 'hub.log'), 'utf-8').split('\n').filter(Boolean); } catch { return []; }
}

export function hostRecords(sb: Sandbox): Record<string, { lastPushAt?: string; lastQueryAt?: string; lastFullManifestAt?: string; refusedCollisions: number }> {
  try { return JSON.parse(readFileSync(join(sb.recallHome, 'run', 'hub-hosts.json'), 'utf-8')); } catch { return {}; }
}
