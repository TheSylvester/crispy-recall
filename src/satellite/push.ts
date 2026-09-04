/**
 * push — the satellite's transcript pusher (spec §3.3).
 *
 * One-way push of transcript BYTES to the hub (D2). The transcript files on
 * disk ARE the spool: every Stop hook and every query re-offers the recent
 * set, and the hub asks for a full manifest at least once per 24 h per host
 * (S15), so an outage of any length is recovered on the first reconnect.
 *
 * Shared by `dist/push-pending.js` (the detached child the Stop hook spawns)
 * and by the CLI's inline flush before a forwarded query (S6) — hence a
 * library, not a script. Never throws: every failure is logged and skipped.
 *
 * @module satellite/push
 */

import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { glob } from 'glob';
import { logsDir, runDir, transcriptGlob } from '../paths.js';
import { deriveProjectKey } from '../recall/project-key.js';
import { readSatelliteConfig } from '../installer/config.js';
import {
  MAX_APPEND_BYTES, MAX_MANIFEST_FILES, HEADER_META,
  encodeMeta, type ManifestResponse, type Vendor, type WireMeta,
} from '../hub/protocol.js';
import { hubRequest, parseJson, HubTransportError } from './hub-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sweep window: files touched inside 7 days (spec §3.3.2). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Run budget for a normal push. */
export const RUN_BUDGET_MS = 120_000;
/** Run budget for `--full`. */
export const FULL_RUN_BUDGET_MS = 30 * 60 * 1000;
/** Lock staleness — matches embed-lock.ts. */
export const LOCK_STALE_MS = 30 * 60 * 1000;
/** Heartbeat period. embed-lock.ts has none; a 30-min `--full` run would
 *  otherwise outlive its own 30-min staleness window and be taken over. */
export const LOCK_HEARTBEAT_MS = 60_000;
/** Bytes of a transcript read when peeking for the session cwd. */
export const CWD_PEEK_BYTES = 64 * 1024;
/** Lines of that peek inspected. */
export const CWD_PEEK_LINES = 20;

/** Every outgoing header value must be printable ASCII (§3.3.3). */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// ---------------------------------------------------------------------------
// Single-flight lock
// ---------------------------------------------------------------------------

export function pushLockPath(): string { return join(runDir(), 'push.lock'); }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Acquire `run/push.lock`. Same two-pass wx semantics as embed-lock.ts. */
export function tryAcquirePushLock(): boolean {
  try { mkdirSync(runDir(), { recursive: true }); } catch { /* best-effort */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(pushLockPath(), String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let heldPid: number;
      let ageMs: number;
      try {
        heldPid = parseInt(readFileSync(pushLockPath(), 'utf8'), 10);
        ageMs = Date.now() - statSync(pushLockPath()).mtimeMs;
      } catch {
        continue; // vanished mid-check — retry the exclusive create
      }
      if (pidAlive(heldPid) && ageMs < LOCK_STALE_MS) return false;
      try { unlinkSync(pushLockPath()); } catch { /* another racer took over */ }
    }
  }
  return false;
}

/** Release the lock only when the stored pid is ours. */
export function releasePushLock(): void {
  try {
    const held = parseInt(readFileSync(pushLockPath(), 'utf8'), 10);
    if (held === process.pid) unlinkSync(pushLockPath());
  } catch { /* ignore */ }
}

/** Refresh the lock's mtime so a long run is never seen as stale. Unref'd. */
function startLockHeartbeat(): () => void {
  const timer = setInterval(() => {
    try {
      const held = parseInt(readFileSync(pushLockPath(), 'utf8'), 10);
      if (held === process.pid) writeFileSync(pushLockPath(), String(process.pid));
    } catch { /* ignore */ }
  }, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function pushLogPath(): string { return join(logsDir(), 'push.log'); }

function pushLog(line: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(pushLogPath(), line.endsWith('\n') ? line : `${line}\n`);
  } catch { /* logging must never throw */ }
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export interface VendorRoot { vendor: Vendor; root: string }

/** The two transcript roots, honoring CLAUDE_CONFIG_DIR / CODEX_HOME. */
export function vendorRoots(): VendorRoot[] {
  return [
    { vendor: 'claude', root: process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude') },
    { vendor: 'codex', root: process.env['CODEX_HOME'] ?? join(homedir(), '.codex') },
  ];
}

function vendorPattern(v: VendorRoot): string {
  return v.vendor === 'claude'
    ? transcriptGlob(v.root, 'projects', '**', '*.jsonl')
    : transcriptGlob(v.root, 'sessions', '**', '*.jsonl');
}

/** `rel` for a file under `root`, forward-slashed. NEVER glob's `posix:true`. */
function relFor(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

/** True when `file` lives under `root`. Compares resolved, `/`-normalized paths. */
function underRoot(root: string, file: string): boolean {
  const r = resolve(root).replace(/\\/g, '/').replace(/\/$/, '');
  const f = resolve(file).replace(/\\/g, '/');
  return f.startsWith(`${r}/`);
}

// ---------------------------------------------------------------------------
// cwd peek
// ---------------------------------------------------------------------------

/**
 * Read the session cwd from the head of a transcript: `cwd` on a Claude
 * entry, `payload.cwd` in the Codex `session_meta`. Bounded to the first
 * 64 KB / 20 lines so a 100 MB rollout costs one read.
 */
export function peekCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(CWD_PEEK_BYTES);
    const n = readSync(fd, buf, 0, CWD_PEEK_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf-8');
    const lines = text.split('\n').slice(0, CWD_PEEK_LINES);
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (typeof entry['cwd'] === 'string' && entry['cwd']) return entry['cwd'] as string;
      const payload = entry['payload'];
      if (payload && typeof payload === 'object') {
        const c = (payload as Record<string, unknown>)['cwd'];
        if (typeof c === 'string' && c) return c;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// runPush
// ---------------------------------------------------------------------------

export interface PushHookMeta { payloadSessionId?: string; agentId?: string; isSubagent: boolean }

export interface PushOptions {
  /** Transcript the Stop hook just finished — pushed FIRST. */
  named?: string;
  /** Hook classification evidence; rides the `--named` file only. */
  hook?: PushHookMeta;
  /** cwd the hook reported, used when the transcript head carries none. */
  cwd?: string;
  /** Enumerate every transcript, not just the 7-day recent set. */
  full?: boolean;
  /** Override the run budget (default 120 s, or 30 min with `full`). */
  budgetMs?: number;
  /** Poll `push.lock` this long before proceeding without it (inline flush). */
  lockWaitMs?: number;
  /** Push even when the lock could not be taken (inline flush, spec §3.4). */
  proceedWithoutLock?: boolean;
}

export interface PushResult {
  /** Files that had bytes appended. */
  pushed: number;
  /** Files already at the hub's offset. */
  unchanged: number;
  /** Files logged and skipped after a failure. */
  failed: number;
  bytes: number;
  /** True when another live pusher held the lock and we stood down. */
  lockBusy?: boolean;
  /** True when a transport failure stopped the run before any file. */
  unreachable?: boolean;
}

interface Ctx {
  hubUrl: string;
  token: string | null;
  host: string;
  deadline: number;
  result: PushResult;
}

const nowIso = () => new Date().toISOString();

function budgetLeft(ctx: Ctx): boolean { return Date.now() < ctx.deadline; }

/** Assert every header value is printable ASCII before it leaves the process. */
export function headersSafe(headers: Record<string, string>): boolean {
  for (const v of Object.values(headers)) if (!PRINTABLE_ASCII.test(v)) return false;
  return true;
}

// The guard is unreachable in normal operation (base64url and
// encodeURIComponent are ASCII by construction), so the skip-and-log branch is
// exercised through this seam — same idiom as paths.ts `_setTestRoot`.
let headerGuard: (h: Record<string, string>) => boolean = headersSafe;
export function _setHeaderGuard(fn: (h: Record<string, string>) => boolean): () => void {
  const prev = headerGuard;
  headerGuard = fn;
  return () => { headerGuard = prev; };
}

/**
 * Push everything the hub is missing. Never throws; always resolves.
 */
export async function runPush(opts: PushOptions = {}): Promise<PushResult> {
  const result: PushResult = { pushed: 0, unchanged: 0, failed: 0, bytes: 0 };
  const sat = readSatelliteConfig();
  if (!sat) return result;

  // ---- single-flight ----
  let haveLock = tryAcquirePushLock();
  if (!haveLock && opts.lockWaitMs) {
    const until = Date.now() + opts.lockWaitMs;
    while (!haveLock && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      haveLock = tryAcquirePushLock();
    }
  }
  if (!haveLock && !opts.proceedWithoutLock) {
    result.lockBusy = true;
    return result;
  }
  const stopHeartbeat = haveLock ? startLockHeartbeat() : () => {};

  const full = opts.full ?? false;
  const ctx: Ctx = {
    hubUrl: sat.hubUrl,
    token: sat.token,
    host: sat.host,
    deadline: Date.now() + (opts.budgetMs ?? (full ? FULL_RUN_BUDGET_MS : RUN_BUDGET_MS)),
    result,
  };

  try {
    let sweepFull = full;
    // Pass 2 only runs when the hub answered `fullSweepDue` on pass 1 (S15).
    for (let pass = 0; pass < 2; pass++) {
      let fullSweepDue = false;
      for (const vr of vendorRoots()) {
        if (!budgetLeft(ctx)) break;
        const r = await pushVendor(ctx, vr, sweepFull, opts);
        if (r.fullSweepDue) fullSweepDue = true;
        if (r.transportFailed) {
          // Nothing was pushed and the hub did not answer — stop the run.
          if (result.pushed === 0) result.unreachable = true;
          return result;
        }
      }
      if (sweepFull || !fullSweepDue) break;
      sweepFull = true;
      ctx.deadline = Date.now() + (opts.budgetMs ?? FULL_RUN_BUDGET_MS);
    }
  } catch (e) {
    // Defensive: runPush must never throw into a detached child or a query.
    pushLog(`${nowIso()} push-failed host=${ctx.host} err=${(e as Error).message}`);
  } finally {
    stopHeartbeat();
    if (haveLock) releasePushLock();
  }
  return result;
}

interface VendorOutcome { fullSweepDue: boolean; transportFailed: boolean }

async function pushVendor(
  ctx: Ctx, vr: VendorRoot, full: boolean, opts: PushOptions,
): Promise<VendorOutcome> {
  const out: VendorOutcome = { fullSweepDue: false, transportFailed: false };

  // ---- enumerate ----
  const named = opts.named && underRoot(vr.root, opts.named) ? resolve(opts.named) : undefined;
  let swept: string[] = [];
  try {
    swept = await glob(vendorPattern(vr), { nodir: true });
  } catch { /* an absent root globs to nothing */ }

  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const seen = new Set<string>();
  const files: Array<{ abs: string; rel: string; size: number; mtime: number; named: boolean }> = [];
  const consider = (abs: string, isNamed: boolean) => {
    const key = resolve(abs);
    if (seen.has(key)) return;
    let st;
    try { st = statSync(abs); } catch { return; }
    if (!isNamed && !full && st.mtimeMs < cutoff) return;
    seen.add(key);
    files.push({ abs, rel: relFor(vr.root, abs), size: st.size, mtime: Math.floor(st.mtimeMs), named: isNamed });
  };
  // The --named file goes first, through the same rel derivation.
  if (named) consider(named, true);
  for (const f of swept) consider(f, false);

  // ---- manifest, in ≤1000-file batches ----
  // An empty vendor still sends ONE empty manifest: that is how a satellite
  // whose recent set is empty learns `fullSweepDue` and recovers from an
  // outage longer than the 7-day window (S15).
  const batches: Array<typeof files> = [];
  for (let i = 0; i < files.length; i += MAX_MANIFEST_FILES) batches.push(files.slice(i, i + MAX_MANIFEST_FILES));
  if (batches.length === 0) batches.push([]);

  for (const batch of batches) {
    if (!budgetLeft(ctx)) return out;
    let res;
    try {
      res = await hubRequest(ctx.hubUrl, {
        method: 'POST',
        path: '/v1/push/manifest',
        token: ctx.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vendor: vr.vendor,
          full,
          files: batch.map((f) => ({ path: f.rel, size: f.size, mtime: f.mtime })),
        }),
      });
    } catch (e) {
      const reason = (e as HubTransportError).reason ?? (e as Error).message;
      pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} err=unreachable ${reason}`);
      out.transportFailed = true;
      return out;
    }
    if (res.status !== 200) {
      pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} err=manifest replied ${res.status}`);
      out.transportFailed = res.status >= 500 || res.status === 401 || res.status === 426;
      return out;
    }
    const body = parseJson<ManifestResponse>(res);
    if (!body || !Array.isArray(body.files)) {
      pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} err=manifest body unparseable`);
      out.transportFailed = true;
      return out;
    }
    if (body.host && !ctx.host) ctx.host = body.host;
    if (body.fullSweepDue) out.fullSweepDue = true;

    const byRel = new Map(batch.map((f) => [f.rel, f]));
    for (const entry of body.files) {
      if (!budgetLeft(ctx)) return out;
      const local = byRel.get(entry.path);
      if (!local) continue;
      await pushFile(ctx, vr, local, entry.offset, entry.reset === true, opts);
    }
  }
  return out;
}

async function pushFile(
  ctx: Ctx,
  vr: VendorRoot,
  local: { abs: string; rel: string; named: boolean },
  hubOffset: number,
  reset: boolean,
  opts: PushOptions,
): Promise<void> {
  let size: number;
  try { size = statSync(local.abs).size; } catch { return; }
  let offset = reset ? 0 : hubOffset;
  if (!reset && offset >= size) {
    ctx.result.unchanged++;
    pushLog(`${nowIso()} unchanged host=${ctx.host} vendor=${vr.vendor} path=${local.rel} offset==size`);
    return;
  }

  const cwd = peekCwd(local.abs) ?? (local.named ? (opts.cwd || undefined) : undefined);
  const key = cwd ? deriveProjectKey(cwd).key : undefined;
  const from = offset;
  let recovered = false;

  let fd: number;
  try { fd = openSync(local.abs, 'r'); } catch (e) {
    ctx.result.failed++;
    pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=${(e as Error).message}`);
    return;
  }
  try {
    let firstChunk = true;
    while (offset < size) {
      if (!budgetLeft(ctx)) return;
      const len = Math.min(MAX_APPEND_BYTES, size - offset);
      const buf = Buffer.alloc(len);
      let read: number;
      try { read = readSync(fd, buf, 0, len, offset); } catch (e) {
        ctx.result.failed++;
        pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=${(e as Error).message}`);
        return;
      }
      if (read <= 0) break;
      const body = buf.subarray(0, read);
      const final = offset + read >= size;
      const meta: WireMeta = {
        ...(cwd ? { cwd } : {}),
        ...(cwd && key ? { key } : {}),
        ...(local.named && opts.hook ? { hook: opts.hook } : {}),
        ...(final ? { final: true } : {}),
        ...(reset && firstChunk ? { reset: true } : {}),
      };
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        [HEADER_META]: encodeMeta(meta),
      };
      if (!headerGuard(headers)) {
        ctx.result.failed++;
        pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=non-ascii header value`);
        return;
      }
      const path =
        `/v1/push/append?vendor=${encodeURIComponent(vr.vendor)}` +
        `&path=${encodeURIComponent(local.rel)}&offset=${offset}`;
      let res;
      try {
        res = await hubRequest(ctx.hubUrl, { method: 'PUT', path, token: ctx.token, headers, body });
      } catch (e) {
        ctx.result.failed++;
        const reason = (e as HubTransportError).reason ?? (e as Error).message;
        pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=unreachable ${reason}`);
        return;
      }
      if (res.status === 409) {
        // The hub moved on (a concurrent pusher, or a reset we did not see).
        // Re-read its size and continue from there ONCE; a second 409 is a
        // real disagreement — log and let the next run re-offer the file.
        if (recovered) {
          ctx.result.failed++;
          pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=409 twice`);
          return;
        }
        recovered = true;
        const conflict = parseJson<{ size: number }>(res);
        const hubSize = typeof conflict?.size === 'number' ? conflict.size : 0;
        offset = hubSize;
        firstChunk = false;
        reset = false;
        try { size = statSync(local.abs).size; } catch { return; }
        if (offset >= size) {
          ctx.result.unchanged++;
          pushLog(`${nowIso()} unchanged host=${ctx.host} vendor=${vr.vendor} path=${local.rel} offset==size`);
          return;
        }
        continue;
      }
      if (res.status !== 200) {
        ctx.result.failed++;
        pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=append replied ${res.status}`);
        return;
      }
      offset += read;
      ctx.result.bytes += read;
      firstChunk = false;
    }
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  ctx.result.pushed++;
  pushLog(`${nowIso()} pushed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} from=${from} to=${offset}`);
}

// ---------------------------------------------------------------------------
// Pending-bytes probe (doctor)
// ---------------------------------------------------------------------------

export interface PendingBytes {
  /** Sum of (size - hub offset) over the recent set, or null when unknown. */
  bytes: number | null;
  /** Files with bytes the hub has not seen. */
  files: number;
  /** Set when the hub could not be asked. */
  error?: string;
}

/**
 * Ask the hub what it is missing WITHOUT pushing anything: the same recent-set
 * manifest a normal run sends, summed as `size - offset`. Doctor-only — it
 * needs a hub round-trip, which is why `recall status` does not report it.
 */
export async function computePendingBytes(): Promise<PendingBytes> {
  const sat = readSatelliteConfig();
  if (!sat) return { bytes: null, files: 0, error: 'not a satellite' };
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let bytes = 0;
  let files = 0;
  for (const vr of vendorRoots()) {
    let swept: string[] = [];
    try { swept = await glob(vendorPattern(vr), { nodir: true }); } catch { continue; }
    const batch: Array<{ path: string; size: number; mtime: number }> = [];
    const sizes = new Map<string, number>();
    for (const abs of swept) {
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const rel = relFor(vr.root, abs);
      sizes.set(rel, st.size);
      batch.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
      if (batch.length >= MAX_MANIFEST_FILES) break;
    }
    if (batch.length === 0) continue;
    let res;
    try {
      res = await hubRequest(sat.hubUrl, {
        method: 'POST',
        path: '/v1/push/manifest',
        token: sat.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vendor: vr.vendor, full: false, files: batch }),
      });
    } catch (e) {
      return { bytes: null, files: 0, error: (e as Error).message };
    }
    if (res.status !== 200) return { bytes: null, files: 0, error: `manifest replied ${res.status}` };
    const body = parseJson<ManifestResponse>(res);
    if (!body || !Array.isArray(body.files)) return { bytes: null, files: 0, error: 'manifest body unparseable' };
    for (const entry of body.files) {
      const size = sizes.get(entry.path);
      if (size === undefined) continue;
      const delta = entry.reset ? size : size - entry.offset;
      if (delta > 0) { bytes += delta; files++; }
    }
  }
  return { bytes, files };
}

// ---------------------------------------------------------------------------
// push.log analysis (doctor)
// ---------------------------------------------------------------------------

export interface PushLogSummary {
  /** ISO timestamp of the most recent successful contact, or null. */
  lastPush: string | null;
  /** Relative paths whose last three log entries are all failures. */
  failingFiles: string[];
}

/**
 * Parse `push.log` into what doctor reports.
 *
 * A run touches a given file at most once, so "failing three consecutive
 * runs" is exactly "the last three entries for this path are all
 * `push-failed`" — no run marker and no client-side state (the satellite is
 * stateless, D8).
 */
export function summarizePushLog(text: string): PushLogSummary {
  const perPath = new Map<string, boolean[]>();
  let lastPush: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const iso = line.slice(0, line.indexOf(' '));
    const ok = /\spushed\s/.test(line) || /\sunchanged\s/.test(line);
    const bad = /\spush-failed\s/.test(line);
    if (ok && iso) lastPush = iso;
    const m = /\spath=(\S+)/.exec(line);
    if (!m || !m[1] || (!ok && !bad)) continue;
    const arr = perPath.get(m[1]) ?? [];
    arr.push(bad);
    perPath.set(m[1], arr);
  }
  const failingFiles: string[] = [];
  for (const [path, states] of perPath) {
    const last3 = states.slice(-3);
    if (last3.length === 3 && last3.every(Boolean)) failingFiles.push(path);
  }
  return { lastPush, failingFiles };
}

/** Read and summarize `~/.recall/logs/push.log`. */
export function readPushLogSummary(): PushLogSummary {
  try {
    return summarizePushLog(readFileSync(pushLogPath(), 'utf-8'));
  } catch {
    return { lastPush: null, failingFiles: [] };
  }
}
