/**
 * Hub HTTP daemon (spec §2.2, §2.3, §2.4, §2.5). `node:http` only (D4).
 *
 * Routing, wire/auth gates, body limits, the three endpoints, the ingest
 * queue, the query runner, the mirror sweep timer, `hub.json` ownership and
 * the shutdown sequence. Everything with a policy decision is a pure
 * function here (`classifyBind`, `checkBindPolicy`) so tests can hit it
 * without a socket.
 *
 * @module hub/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../db.js';
import { binDir } from '../paths.js';
import { getBinaryPath, getModelPath } from '../recall/embedder.js';
import { mergeMirrorMeta, readMirrorMeta } from '../recall/mirror-meta.js';
import type { ScanResult } from '../recall/mtime-scan.js';
import {
  IngestQueue, runPushIngest, type PushIngestDeps, type PushIngestJob, type PushIngestOutcome,
} from './ingest-queue.js';
import { hashFilePrefix, headWindow, HEX64_RE } from './hash.js';
import {
  appendMirrorBytes, resolveMirrorPath, withFileLock, writeSidecar,
  type AppendFail, type AppendOk,
} from './mirror.js';
import {
  HEADER_META, HEADER_STALE, HEADER_WIRE, MAX_APPEND_BYTES, MAX_MANIFEST_BODY, MAX_MANIFEST_FILES,
  MAX_QUERY_BODY, WIRE_VERSION, decodeMeta, metaToSidecar, parseVendor,
  type HealthResponse, type ManifestResponse, type ManifestResponseFile, type WireMismatchResponse,
} from './protocol.js';
import { HUB_DRAIN_CAP_MS, QueryRunner, buildHubArgv, validateQueryBody } from './query.js';
import { HubLock, hubLog, pushRefusedRecent, readHostRecords, readPackageVersion, updateHostRecord } from './runtime.js';
import { runMirrorSweep, sweepIntervalMs } from './sweep.js';
import { TokenStore } from './tokens.js';

// ---------------------------------------------------------------------------
// Bind rule (§2.2)
// ---------------------------------------------------------------------------

export type BindClass = 'any' | 'loopback' | 'other';

/** ANY = `0.0.0.0`, `::`, `0:0:0:0:0:0:0:0`, `[::]`, `''` or an absent key. */
export function classifyBind(bind: string | undefined): BindClass {
  if (bind === undefined) return 'any';
  const b = bind.trim().toLowerCase();
  if (b === '' || b === '0.0.0.0' || b === '::' || b === '0:0:0:0:0:0:0:0' || b === '[::]') return 'any';
  if (b === 'localhost' || b === '::1' || b === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b)) return 'loopback';
  return 'other';
}

export interface BindPolicyInput {
  publicOk: boolean;
  tokenCount: number;
}

/**
 * ANY is refused unless `--i-know-this-is-public` was passed, and a token is
 * still required; any non-loopback bind requires ≥ 1 token.
 */
export function checkBindPolicy(
  bind: string | undefined,
  input: BindPolicyInput,
): { ok: true; bind: string; cls: BindClass } | { ok: false; message: string } {
  const cls = classifyBind(bind);
  const shown = bind === undefined ? '(absent bind key)' : bind === '' ? "''" : bind;
  if (cls === 'any' && !input.publicOk) {
    return {
      ok: false,
      message:
        `recall hub: refusing to bind ${shown} — that listens on EVERY interface. ` +
        'Set --bind to a specific address (127.0.0.1 or your Tailscale address), or pass ' +
        '--i-know-this-is-public to allow it; a token from `recall hub token --host <name>` is still required.',
    };
  }
  if (cls !== 'loopback' && input.tokenCount < 1) {
    return {
      ok: false,
      message:
        `recall hub: a non-loopback bind (${shown}) requires at least one token — ` +
        'run `recall hub token --host <name>` first.',
    };
  }
  // Explicit host for listen(): an ANY bind is passed as '::' (dual-stack on
  // Linux) when it was absent/empty/bracketed, else as written.
  const effective = cls === 'any'
    ? (bind === undefined || bind.trim() === '' || bind.trim() === '[::]' ? '::' : bind.trim())
    : bind!.trim();
  return { ok: true, bind: effective === '[::1]' ? '::1' : effective, cls };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface HubServerOptions {
  bind: string;
  port: number;
  /** Clock for `fullSweepDue` (tests inject). */
  now?: () => number;
  /** Sweep interval; `null` disables the timer. Default `RECALL_HUB_SWEEP_MS`. */
  sweepMs?: number | null;
  /** Run the startup sweep (default true). */
  startupSweep?: boolean;
  /** Ingest-queue drain cap before a query (default 10 s). */
  drainCapMs?: number;
  queryRunner?: QueryRunner;
  /** Test seam: replaces the §2.4 job body. */
  runIngest?: (job: PushIngestJob, deps: PushIngestDeps) => Promise<PushIngestOutcome>;
  /** Test seam: replaces the detached embed-pending spawn. */
  spawnEmbed?: (canonicalId: string) => void;
  /** Install SIGINT/SIGTERM/SIGUSR1 handlers (the CLI does; tests do not). */
  installSignalHandlers?: boolean;
  /** `process.exit(0)` after a signal-driven shutdown (the CLI does). */
  exitOnShutdown?: boolean;
  /** Whole-request deadline; tests shorten it. Default `HUB_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
}

/**
 * L6: a body deadline. `requestTimeout = 0` plus a `readExact` that waits
 * forever meant one authenticated satellite could announce a Content-Length,
 * send nothing, and pin a socket (and its `withFileLock` turn) for the life of
 * the daemon. 5 minutes is far longer than any legitimate 8 MiB append and
 * bounds the leak. It measures request RECEIPT only, so a slow query response
 * is unaffected.
 */
export const HUB_REQUEST_TIMEOUT_MS = 300_000;

export interface HubHandle {
  server: Server;
  port: number;
  address: string;
  queue: IngestQueue;
  sweep(): Promise<ScanResult>;
  stop(): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `appendMirrorBytes`'s result, plus the hub-side prefix rejection (D1). */
type AppendOutcome = AppendOk | (AppendFail & { prefixMismatch?: true });

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...(headers ?? {}),
  });
  res.end(text);
}

/** Reject before the body was consumed: drain it so the socket stays sane. */
function reject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  // The body is unread: close after answering so the socket never stalls on
  // bytes we will not consume (an 8 MiB 413, a chunked 411, a 426/401 push).
  sendJson(res, status, body, { connection: 'close' });
  req.resume();
}

type BodyRead = { ok: true; buf: Buffer } | { ok: false; reason: 'too-large' | 'short' | 'aborted' };

/** Read up to `max` bytes; more → `too-large` (the rest is drained). */
function readBounded(req: IncomingMessage, max: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > max) {
      req.resume();
      resolve({ ok: false, reason: 'too-large' });
      return;
    }
    const chunks: Buffer[] = [];
    let got = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      got += c.length;
      if (got > max) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? { ok: false, reason: 'too-large' } : { ok: true, buf: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ ok: false, reason: 'aborted' }));
    req.on('aborted', () => resolve({ ok: false, reason: 'aborted' }));
  });
}

/** Read EXACTLY `length` bytes (Content-Length); an early socket end → `short`. */
function readExact(req: IncomingMessage, length: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let got = 0;
    let settled = false;
    const finish = (r: BodyRead): void => { if (!settled) { settled = true; resolve(r); } };
    req.on('data', (c: Buffer) => { chunks.push(c); got += c.length; });
    req.on('end', () => finish(got === length ? { ok: true, buf: Buffer.concat(chunks) } : { ok: false, reason: 'short' }));
    req.on('error', () => finish({ ok: false, reason: 'short' }));
    req.on('aborted', () => finish({ ok: false, reason: 'short' }));
  });
}

function parseJson(buf: Buffer): unknown | Error {
  try { return JSON.parse(buf.toString('utf8')); } catch { return new Error('body is not JSON'); }
}

function defaultSpawnEmbed(canonicalId: string): void {
  const child = join(binDir(), 'embed-pending.js');
  if (!existsSync(child)) return;
  // No pre-spawn close: the daemon holds a LIVE connection for its whole
  // lifetime, and that connection's shared DMS lock denies the child the
  // exclusive lock a wal-index reset needs (db.ts closeDbBeforeChildSpawn).
  spawn(process.execPath, [child, canonicalId], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function startHubServer(opts: HubServerOptions): Promise<HubHandle> {
  const now = opts.now ?? (() => Date.now());
  const version = readPackageVersion();
  const tokens = new TokenStore();
  const queue = new IngestQueue();
  const runner = opts.queryRunner ?? new QueryRunner();
  const runIngest = opts.runIngest ?? runPushIngest;
  const spawnEmbed = opts.spawnEmbed ?? defaultSpawnEmbed;
  const drainCapMs = opts.drainCapMs ?? HUB_DRAIN_CAP_MS;
  const ingestDeps: PushIngestDeps = {
    spawnEmbed,
    log: hubLog,
    onRefused: (host, sid) => {
      updateHostRecord(host, (r) => ({
        ...r,
        refusedCollisions: r.refusedCollisions + 1,
        refusedRecent: pushRefusedRecent(r.refusedRecent, sid),
      }));
    },
  };

  const lock = new HubLock();
  const acquired = lock.acquire(opts.bind, opts.port);
  if (!acquired.ok) {
    throw new Error(
      acquired.existingPid !== undefined
        ? `recall hub: already running (pid ${acquired.existingPid}) — stop it first or check \`recall hub status\``
        : 'recall hub: run/hub.json exists and is unreadable; remove it if no daemon is running',
    );
  }

  // ---- endpoints -----------------------------------------------------------

  function health(): HealthResponse {
    return {
      ok: true, version, wire: WIRE_VERSION, hub: hostname(),
      runtime: { binary: existsSync(getBinaryPath()), model: existsSync(getModelPath()) },
    };
  }

  async function handleManifest(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    const body = await readBounded(req, MAX_MANIFEST_BODY);
    if (!body.ok) return sendJson(res, body.reason === 'too-large' ? 413 : 400, { error: body.reason === 'too-large' ? `manifest body exceeds ${MAX_MANIFEST_BODY} bytes` : 'body incomplete' });
    const parsed = parseJson(body.buf);
    if (parsed instanceof Error || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { error: 'manifest body must be a JSON object' });
    const m = parsed as Record<string, unknown>;
    const vendor = parseVendor(m['vendor']);
    if (!vendor) return sendJson(res, 400, { error: 'vendor must be claude or codex' });
    if (typeof m['full'] !== 'boolean') return sendJson(res, 400, { error: 'full must be a boolean' });
    const files = m['files'];
    if (!Array.isArray(files)) return sendJson(res, 400, { error: 'files must be an array' });
    if (files.length > MAX_MANIFEST_FILES) return sendJson(res, 400, { error: `files exceeds ${MAX_MANIFEST_FILES} entries` });

    const out: ManifestResponseFile[] = [];
    for (const f of files) {
      if (!f || typeof f !== 'object') return sendJson(res, 400, { error: 'files entries must be objects' });
      const e = f as Record<string, unknown>;
      if (typeof e['path'] !== 'string') return sendJson(res, 400, { error: 'files[].path must be a string' });
      if (typeof e['size'] !== 'number' || !Number.isInteger(e['size']) || e['size'] < 0) return sendJson(res, 400, { error: 'files[].size must be a non-negative integer' });
      if (typeof e['mtime'] !== 'number') return sendJson(res, 400, { error: 'files[].mtime must be a number' });
      if (e['head'] !== undefined && (typeof e['head'] !== 'string' || !HEX64_RE.test(e['head']))) {
        return sendJson(res, 400, { error: 'files[].head must be 64 lowercase hex characters' });
      }
      const resolved = resolveMirrorPath(host, vendor, e['path']);
      if (!resolved.ok) {
        hubLog(`path-rejected host=${host} endpoint=manifest reason=${resolved.reason}`);
        return sendJson(res, 400, { error: `path rejected: ${resolved.reason}` });
      }
      let offset = 0;
      try { offset = statSync(resolved.abs).size; } catch { offset = 0; }
      // D1: the satellite's file may have been REWRITTEN IN PLACE under a
      // stable mtime (Codex Desktop 0.153.1 did exactly that), so a byte
      // offset alone cannot say the mirror is a prefix of it. Compare the
      // first `min(satSize, HEAD_BYTES)` bytes when the satellite sent a
      // hash and the mirror is at least that long; a shorter mirror is left
      // to the append-time `prefix` check.
      const head = typeof e['head'] === 'string' ? e['head'] : undefined;
      const window = headWindow(e['size']);
      if (head !== undefined && offset >= window && window > 0) {
        const mine = hashFilePrefix(resolved.abs, window);
        if (mine !== null && mine !== head) {
          hubLog(`prefix-mismatch host=${host} vendor=${vendor} path=${resolved.rel} via=head`);
          out.push({ path: e['path'], offset: 0, reset: true as const });
          continue;
        }
      }
      out.push({ path: e['path'], offset, ...(offset > e['size'] ? { reset: true as const } : {}) });
    }

    const t = now();
    if (m['full']) {
      updateHostRecord(host, (r) => ({ ...r, lastFullManifestAt: new Date(t).toISOString() }));
    }
    const last = readHostRecords()[host]?.lastFullManifestAt;
    const lastMs = last ? Date.parse(last) : NaN;
    const fullSweepDue = !Number.isFinite(lastMs) || t - lastMs > DAY_MS;
    hubLog(`manifest host=${host} vendor=${vendor} full=${String(m['full'])} files=${files.length} due=${fullSweepDue}`);
    // D5: the calling host's own refusal record rides every manifest reply —
    // that is the ONLY channel a satellite has to learn its pushes were
    // refused (its doctor has no hub log and no database).
    const record = readHostRecords()[host];
    const response: ManifestResponse = {
      host, fullSweepDue, files: out,
      refusedCollisions: record?.refusedCollisions ?? 0,
      refusedRecent: record?.refusedRecent ?? [],
    };
    sendJson(res, 200, response);
  }

  async function handleAppend(req: IncomingMessage, res: ServerResponse, host: string, url: URL): Promise<void> {
    const vendor = parseVendor(url.searchParams.get('vendor'));
    if (!vendor) return reject(req, res, 400, { error: 'vendor must be claude or codex' });
    const offsetRaw = url.searchParams.get('offset');
    if (offsetRaw === null || !/^\d+$/.test(offsetRaw)) return reject(req, res, 400, { error: 'offset must be a non-negative integer' });
    const offset = Number(offsetRaw);
    const cl = req.headers['content-length'];
    if (typeof cl !== 'string' || !/^\d+$/.test(cl)) return reject(req, res, 411, { error: 'Content-Length required' });
    const length = Number(cl);
    if (length > MAX_APPEND_BYTES) return reject(req, res, 413, { error: `body exceeds ${MAX_APPEND_BYTES} bytes` });
    const metaHeader = req.headers[HEADER_META];
    const meta = decodeMeta(Array.isArray(metaHeader) ? metaHeader[0] : metaHeader);
    if (meta instanceof Error) return reject(req, res, 400, { error: meta.message });
    const resolved = resolveMirrorPath(host, vendor, url.searchParams.get('path') ?? '');
    if (!resolved.ok) {
      hubLog(`path-rejected host=${host} endpoint=append reason=${resolved.reason}`);
      return reject(req, res, 400, { error: `path rejected: ${resolved.reason}` });
    }
    if (meta.reset && offset !== 0) return reject(req, res, 400, { error: 'reset requires offset=0' });

    const body = await readExact(req, length);
    if (!body.ok) {
      try { sendJson(res, 400, { error: 'body ended before Content-Length bytes' }); } catch { /* socket gone */ }
      return;
    }

    const { abs, rel } = resolved;
    const result = await withFileLock(abs, (): AppendOutcome => {
      const nowDate = new Date(now());
      // D1: before ANY bytes land, prove the mirror's `[0, offset)` is the
      // same prefix the satellite is resuming from. Only when the sizes
      // already agree — a size disagreement is the existing 409 `{size}`
      // recovery, and the satellite re-offers the file with a new offset.
      if (meta.prefix !== undefined && !meta.reset && offset > 0) {
        let current = -1;
        try { current = statSync(abs).size; } catch { current = -1; }
        if (current === offset) {
          const mine = hashFilePrefix(abs, offset);
          if (mine !== null && mine !== meta.prefix) {
            return { ok: false, status: 409, size: current, prefixMismatch: true, reason: 'prefix mismatch' };
          }
        }
      }
      const r = appendMirrorBytes(abs, body.buf, { offset, reset: !!meta.reset, now: nowDate });
      // M2: MERGE, never clobber. Chunk 2 of a session usually carries no
      // `cwd`/`key` at all (push.ts only re-peeks the head of the file), and
      // writing this append's meta verbatim would drop the key chunk 1
      // established — leaving the rows reachable only through `--all`.
      if (r.ok) {
        writeSidecar(abs, mergeMirrorMeta(readMirrorMeta(abs), metaToSidecar(host, meta, nowDate.toISOString())));
      }
      return r;
    });
    if (!result.ok) {
      if (result.status === 409) {
        if (result.prefixMismatch) {
          hubLog(`prefix-mismatch host=${host} vendor=${vendor} path=${rel} via=prefix`);
          return sendJson(res, 409, { size: result.size ?? 0, prefixMismatch: true });
        }
        return sendJson(res, 409, { size: result.size ?? 0 });
      }
      return sendJson(res, 400, { error: result.reason });
    }
    updateHostRecord(host, (r) => ({ ...r, lastPushAt: new Date(now()).toISOString() }));
    sendJson(res, 200, { size: result.size });
    hubLog(`append host=${host} vendor=${vendor} path=${rel} offset=${offset} bytes=${body.buf.length} size=${result.size}${meta.reset ? ' reset' : ''}${meta.final ? ' final' : ''}`);

    const endsWithNewline = body.buf.length > 0 && body.buf[body.buf.length - 1] === 0x0a;
    if (endsWithNewline || meta.final) {
      const job: PushIngestJob = {
        host, vendor, rel, abs, mtimeInt: result.mtimeInt, size: result.size, meta, reset: !!meta.reset,
      };
      queue.enqueue(host, async () => { await runIngest(job, ingestDeps); });
    }
  }

  async function handleQuery(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    const body = await readBounded(req, MAX_QUERY_BODY);
    if (!body.ok) return sendJson(res, 400, { error: body.reason === 'too-large' ? `query body exceeds ${MAX_QUERY_BODY} bytes` : 'body incomplete' });
    const parsed = parseJson(body.buf);
    if (parsed instanceof Error) return sendJson(res, 400, { error: parsed.message });
    const v = validateQueryBody(parsed);
    if (!v.ok) return sendJson(res, 400, { error: v.reason });
    const built = buildHubArgv(v.req);
    if (!built.ok) return sendJson(res, 400, { error: built.reason });
    updateHostRecord(host, (r) => ({ ...r, lastQueryAt: new Date(now()).toISOString() }));

    const t0 = Date.now();
    const drained = await queue.waitForHost(host, drainCapMs);
    const run = await runner.run(built.argv);
    const ms = Date.now() - t0;
    if (run.kind === 'busy') { hubLog(`query host=${host} busy`); return sendJson(res, 503, { error: 'hub query queue full' }); }
    if (run.kind === 'timeout') { hubLog(`query host=${host} timeout ms=${ms}`); return sendJson(res, 504, { error: 'query timed out' }); }
    hubLog(`query host=${host} exit=${run.body.exit} ms=${ms}${drained ? '' : ' stale'}`);
    sendJson(res, 200, run.body, drained ? undefined : { [HEADER_STALE]: '1' });
  }

  // ---- router ----------------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub');
    const path = url.pathname;
    if (path === '/v1/health') {
      if (req.method !== 'GET') return reject(req, res, 405, { error: 'method not allowed' });
      return reject(req, res, 200, health());
    }
    const known = path === '/v1/push/manifest' || path === '/v1/push/append' || path === '/v1/query';
    if (!known) return reject(req, res, 404, { error: 'not found' });

    // Wire BEFORE auth: a mismatched client learns why.
    const wire = req.headers[HEADER_WIRE];
    if (wire !== String(WIRE_VERSION)) {
      const body: WireMismatchResponse = { wire: WIRE_VERSION, version };
      return reject(req, res, 426, body);
    }
    const host = tokens.authenticate(req.headers['authorization']);
    if (!host) return reject(req, res, 401, { error: 'unauthorized' });

    if (path === '/v1/push/manifest') {
      if (req.method !== 'POST') return reject(req, res, 405, { error: 'method not allowed' });
      return handleManifest(req, res, host);
    }
    if (path === '/v1/push/append') {
      if (req.method !== 'PUT') return reject(req, res, 405, { error: 'method not allowed' });
      return handleAppend(req, res, host, url);
    }
    if (req.method !== 'POST') return reject(req, res, 405, { error: 'method not allowed' });
    return handleQuery(req, res, host);
  }

  // 64 KiB header budget: an oversize `X-Recall-Meta` must reach the handler
  // and be answered 400 by `decodeMeta`, not cut off by node's 16 KiB default
  // as a 431 (base64url inflates the 16 KiB decoded cap to ~21.8 KiB on the
  // wire).
  const requestTimeoutMs = opts.requestTimeoutMs ?? HUB_REQUEST_TIMEOUT_MS;
  const server = createServer({
    maxHeaderSize: 64 * 1024,
    // L6: both deadlines MUST be createServer OPTIONS, never post-construction
    // property assignments. Measured on node 22.18: assigning EITHER
    // `server.requestTimeout` or `server.headersTimeout` after the server
    // exists silently disarms the timeout sweep for the whole server — which
    // is why the previous `requestTimeout = 0; headersTimeout = 60_000;` pair
    // left a headers-only append able to pin a socket for the life of the
    // daemon, with no header deadline either.
    requestTimeout: requestTimeoutMs,
    // node validates `headersTimeout <= requestTimeout`; header receipt is a
    // subset of request receipt, so clamping is the honest reading of both.
    headersTimeout: Math.min(60_000, requestTimeoutMs),
    // node checks the deadlines on a SWEEP, not a per-socket timer, so a
    // deadline shorter than the sweep interval never fires. Production keeps
    // node's 30 s sweep (300 s / 4 caps back to it); a test that injects a
    // sub-second deadline gets a proportionally short sweep.
    connectionsCheckingInterval: Math.min(30_000, Math.max(50, Math.floor(requestTimeoutMs / 4))),
  }, (req, res) => {
    handle(req, res).catch((e) => {
      hubLog(`request-error ${(e as Error).message}`);
      try { sendJson(res, 500, { error: 'internal error' }); } catch { /* socket gone */ }
    });
  });

  // ---- lifecycle ---------------------------------------------------------------

  let sweepTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  function enqueueSweep(reason: string): Promise<ScanResult> {
    return new Promise((resolve) => {
      queue.enqueue(null, async () => {
        try {
          const r = await runMirrorSweep();
          hubLog(`sweep reason=${reason} scanned=${r.scanned} unchanged=${r.unchanged} ingested=${r.ingested} refused=${r.refused} failed=${r.failed}`);
          resolve(r);
        } catch (e) {
          hubLog(`sweep-failed reason=${reason} err=${(e as Error).message}`);
          resolve({ scanned: 0, unchanged: 0, ingested: 0, refused: 0, failed: 1 });
        }
      });
    });
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    await queue.idle(10_000);
    try { closeDb(); } catch { /* ignore */ }
    lock.release();
    hubLog('hub-stop');
  }

  const onSignal = (sig: string): void => {
    hubLog(`signal ${sig}`);
    void stop().then(() => { if (opts.exitOnShutdown) process.exit(0); });
  };
  if (opts.installSignalHandlers) {
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    if (process.platform !== 'win32') process.on('SIGUSR1', () => { void enqueueSweep('SIGUSR1'); });
  }

  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      lock.release();
      rejectListen(new Error(`recall hub: cannot bind ${opts.bind}:${opts.port} (${e.code ?? e.message})`));
    });
    server.listen(opts.port, opts.bind, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  lock.updatePort(addr.port, addr.address);
  lock.startHeartbeat();
  hubLog(`hub-start pid=${process.pid} bind=${opts.bind} address=${addr.address} port=${addr.port} version=${version} wire=${WIRE_VERSION}`);

  if (opts.startupSweep !== false) void enqueueSweep('startup');
  const interval = opts.sweepMs === undefined ? sweepIntervalMs() : opts.sweepMs;
  if (interval !== null && interval > 0) {
    sweepTimer = setInterval(() => { void enqueueSweep('timer'); }, interval);
    sweepTimer.unref();
  }

  return {
    server, port: addr.port, address: addr.address, queue,
    sweep: () => enqueueSweep('manual'),
    stop,
  };
}
