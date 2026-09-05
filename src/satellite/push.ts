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
 * PUSH INTEGRITY (D1). Resuming by byte offset is only sound while a
 * transcript is append-only. Codex Desktop 0.153.1 rewrote older rollouts IN
 * PLACE — it added `ordinal` and `payload.session_id` to every line — and the
 * NTFS mtime stayed at its March value, so the pusher appended the tail of the
 * NEW file onto the OLD prefix and every mirror ended with a torn JSON line at
 * the seam. Two hashes close that:
 *   - every manifest entry carries `head`, the sha256 of `[0, min(size,
 *     HEAD_BYTES))`, so the hub answers `reset` when its first 4 KB differ;
 *   - the first chunk of a RESUMED append carries `prefix`, the sha256 of
 *     `[0, offset)`, so a rewrite past the head window is caught before any
 *     byte lands (409 `prefixMismatch` → reset).
 * COST: the prefix hash is O(file) on both sides, once per resumed push.
 * Transcripts are tens of MB at worst, so this is a read, not a rewrite.
 * KNOWN LIMITATIONS, both self-healing:
 *   - a rewrite that keeps the size IDENTICAL and leaves the first 4 KB
 *     unchanged is invisible until the file grows — at which point the
 *     `prefix` hash catches it on the next resumed append;
 *   - a rewrite that lands BETWEEN the chunks of a multi-chunk push is not
 *     caught inside that run, because only the FIRST chunk carries `prefix`
 *     (one hash per resumed push, not one per 8 MiB chunk). The next run
 *     re-offers the file and catches it through `head`, or through `prefix`
 *     once the file grows again.
 *
 * @module satellite/push
 */

import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync,
  statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { glob } from 'glob';
import { logsDir, runDir, transcriptGlob } from '../paths.js';
import { deriveProjectKey } from '../recall/project-key.js';
import { readSatelliteConfig } from '../installer/config.js';
import {
  MAX_APPEND_BYTES, MAX_MANIFEST_FILES, HEADER_META,
  encodeMeta, type AppendConflictResponse, type ManifestFile as WireManifestFile,
  type ManifestResponse, type HubVendor, type AppendMeta,
} from '../hub/protocol.js';
import { hashFileHead, hashFilePrefix } from '../hub/hash.js';
import { hubRequest, parseJson, HubTransportError, REQUEST_TIMEOUT_MS } from './hub-client.js';

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
/**
 * Soft ceiling for a serialised manifest body: 32 KiB under the hub's
 * `MAX_MANIFEST_BODY` (256 KiB). A batch of 1000 mirror-relative paths —
 * `projects/<encoded-cwd>/<uuid>.jsonl` is ~100-110 bytes, more for a deep or
 * non-ASCII cwd — can cross 256 KiB well before it reaches 1000 files, so the
 * batcher bounds by BOTH count and bytes. The margin absorbs the envelope and
 * any UTF-8 expansion the estimate under-counts.
 */
export const MANIFEST_BODY_SOFT_LIMIT = 224 * 1024;

/** Serialized size of the `head` field a manifest entry carries. */
export const HEAD_FIELD_BYTES = Buffer.byteLength(',"head":"' + 'a'.repeat(64) + '"', 'utf8');

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
  // A non-finite pid (an empty or garbled lock file) is not a live holder, and
  // `process.kill(NaN, 0)` THROWS ERR_OUT_OF_RANGE rather than returning —
  // which would escape this helper and abandon the whole run.
  if (!Number.isInteger(pid) || pid <= 0) return false;
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

/**
 * Refresh the lock's mtime so a long run is never seen as stale. Unref'd.
 *
 * Bumps the mtime rather than rewriting the file: a `writeFileSync` truncates
 * first, so a racer reading in that window sees an EMPTY file, parses NaN and
 * takes over a LIVE lock.
 */
export function startLockHeartbeat(intervalMs = LOCK_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    try {
      const held = parseInt(readFileSync(pushLockPath(), 'utf8'), 10);
      if (held === process.pid) {
        const now = new Date();
        utimesSync(pushLockPath(), now, now);
      }
    } catch { /* ignore */ }
  }, intervalMs);
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

export interface VendorRoot { vendor: HubVendor; root: string }

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
  /**
   * Allow a `fullSweepDue` answer to escalate this run to a full sweep
   * (default true). The pre-query inline flush passes false: S6 bounds it to
   * ~5 s and §3.4 says "recent set only, never --full", so a hub asking for
   * its ≤24 h full manifest must not re-enumerate every transcript inside the
   * user's interactive `recall` call. The detached pusher answers it instead.
   */
  allowFullSweep?: boolean;
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
  /** Refusals the hub reported for this host, when it reported any (D5). */
  refused?: RefusalReport;
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

/**
 * Per-request timeout, clamped to what is left of the run budget.
 *
 * The budget is otherwise only checked BETWEEN requests, so one slow hub reply
 * could hold a 5 s inline flush for the full 30 s request window while the
 * user waits on `recall`.
 */
function reqTimeout(ctx: Ctx): number {
  return Math.min(REQUEST_TIMEOUT_MS, Math.max(500, ctx.deadline - Date.now()));
}

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

  let refused: RefusalReport | undefined;
  try {
    let sweepFull = full;
    // Pass 2 only runs when the hub answered `fullSweepDue` on pass 1 (S15).
    for (let pass = 0; pass < 2; pass++) {
      let fullSweepDue = false;
      for (const vr of vendorRoots()) {
        if (!budgetLeft(ctx)) break;
        const r = await pushVendor(ctx, vr, sweepFull, opts);
        if (r.fullSweepDue) fullSweepDue = true;
        if (r.refused) refused = r.refused;
        if (r.transportFailed) {
          // Nothing was pushed and the hub did not answer — stop the run.
          if (result.pushed === 0) result.unreachable = true;
          return result;
        }
      }
      if (sweepFull || !fullSweepDue || opts.allowFullSweep === false) break;
      sweepFull = true;
      ctx.deadline = Date.now() + (opts.budgetMs ?? FULL_RUN_BUDGET_MS);
    }
  } catch (e) {
    // Defensive: runPush must never throw into a detached child or a query.
    pushLog(`${nowIso()} push-failed host=${ctx.host} err=${(e as Error).message}`);
  } finally {
    stopHeartbeat();
    if (haveLock) releasePushLock();
    // D5: ONE line per run. The satellite has no hub log and no database, so
    // this line and the manifest reply are its only evidence that sessions of
    // its own were refused and are therefore NOT indexed on the hub.
    if (refused && refused.count > 0) {
      pushLog(`${nowIso()} hub-refused host=${ctx.host} count=${refused.count} recent=${refused.recent.join(',')}`);
      result.refused = refused;
    }
  }
  return result;
}

interface VendorOutcome { fullSweepDue: boolean; transportFailed: boolean; refused?: RefusalReport }

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

  // ---- manifest batches ----
  // An empty vendor still sends ONE empty manifest: that is how a satellite
  // whose recent set is empty learns `fullSweepDue` and recovers from an
  // outage longer than the 7-day window (S15).
  const batches = planManifestBatches(files, vr.vendor, full);

  for (const batch of batches) {
    if (!budgetLeft(ctx)) return out;
    const r = await sendManifestBatch(ctx, vr, full, batch, opts);
    if (r.fullSweepDue) out.fullSweepDue = true;
    if (r.refused) out.refused = r.refused;
    if (r.kind === 'fatal') { out.transportFailed = true; return out; }
  }
  return out;
}

type ManifestFile = { abs: string; rel: string; size: number; mtime: number; named: boolean };

/**
 * The ONE manifest-entry builder (D1): `sendManifestBatch` and the doctor's
 * `computePendingBytes` must describe a file identically, or the doctor would
 * report pending bytes the real push then resets — or the reverse.
 */
export function manifestEntry(abs: string, rel: string, size: number, mtime: number): WireManifestFile {
  const head = hashFileHead(abs, size);
  return { path: rel, size, mtime, ...(head !== null ? { head } : {}) };
}

/**
 * Split `files` into manifest batches bounded by BOTH `MAX_MANIFEST_FILES`
 * and `MANIFEST_BODY_SOFT_LIMIT`.
 *
 * Sizes are accumulated per entry rather than re-serialising the whole body
 * per file, which would be quadratic on a `--full` sweep of tens of thousands
 * of transcripts.
 */
export function planManifestBatches<T extends { rel: string; size: number; mtime: number }>(
  files: T[], vendor: HubVendor, full: boolean,
): T[][] {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ vendor, full, files: [] }), 'utf8');
  const batches: T[][] = [];
  let cur: T[] = [];
  let bytes = envelopeBytes;
  for (const f of files) {
    // +1 for the separating comma; +76 for the `head` field the builder adds
    // (`,"head":"<64 hex>"`), which is not known here but always sent.
    const entryBytes = Buffer.byteLength(
      JSON.stringify({ path: f.rel, size: f.size, mtime: f.mtime }), 'utf8',
    ) + 1 + HEAD_FIELD_BYTES;
    if (cur.length > 0 && (cur.length >= MAX_MANIFEST_FILES || bytes + entryBytes > MANIFEST_BODY_SOFT_LIMIT)) {
      batches.push(cur);
      cur = [];
      bytes = envelopeBytes;
    }
    cur.push(f);
    bytes += entryBytes;
  }
  if (cur.length > 0) batches.push(cur);
  if (batches.length === 0) batches.push([]);
  return batches;
}

interface BatchOutcome { kind: 'ok' | 'skipped' | 'fatal'; fullSweepDue: boolean; refused?: RefusalReport }

/** What the hub told THIS host about refused pushes of its own sessions (D5). */
export interface RefusalReport { count: number; recent: string[] }

/** `refusedCollisions` / `refusedRecent` of a manifest reply, read
 *  defensively: a pre-0.4.0-sat.3 hub sends neither. */
function readRefusal(body: Partial<ManifestResponse>): RefusalReport | undefined {
  const count = typeof body.refusedCollisions === 'number' ? body.refusedCollisions : 0;
  if (count <= 0) return undefined;
  const recent = Array.isArray(body.refusedRecent)
    ? body.refusedRecent.filter((s): s is string => typeof s === 'string')
    : [];
  return { count, recent };
}

/**
 * Send ONE manifest batch and push whatever it asks for.
 *
 * A `413` means this body was too large for the hub even though our own
 * estimate passed (a longer path than we counted, a different hub limit): halve
 * the batch and retry both halves, down to a single file. A single file that
 * still 413s is logged and skipped — it is that file's problem, never the
 * run's, so a 413 never sets `transportFailed`.
 */
async function sendManifestBatch(
  ctx: Ctx, vr: VendorRoot, full: boolean, batch: ManifestFile[], opts: PushOptions,
): Promise<BatchOutcome> {
  if (!budgetLeft(ctx)) return { kind: 'skipped', fullSweepDue: false };
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
        files: batch.map((f) => manifestEntry(f.abs, f.rel, f.size, f.mtime)),
      }),
      timeoutMs: reqTimeout(ctx),
    });
  } catch (e) {
    const reason = (e as HubTransportError).reason ?? (e as Error).message;
    pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} err=unreachable ${reason}`);
    return { kind: 'fatal', fullSweepDue: false };
  }

  if (res.status === 413) {
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const a = await sendManifestBatch(ctx, vr, full, batch.slice(0, mid), opts);
      const b = await sendManifestBatch(ctx, vr, full, batch.slice(mid), opts);
      const kind = a.kind === 'fatal' || b.kind === 'fatal' ? 'fatal' : 'ok';
      const refused = b.refused ?? a.refused;
      return { kind, fullSweepDue: a.fullSweepDue || b.fullSweepDue, ...(refused ? { refused } : {}) };
    }
    pushLog(`${nowIso()} manifest replied 413 path=${batch[0]?.rel ?? '(empty batch)'}`);
    return { kind: 'skipped', fullSweepDue: false };
  }

  if (res.status !== 200) {
    pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} err=manifest replied ${res.status}`);
    // 401/426/5xx are whole-run conditions: no later batch can succeed.
    // Anything else is this batch's problem, so the remaining batches — a
    // different set of files — still get their chance.
    if (res.status >= 500 || res.status === 401 || res.status === 426) {
      return { kind: 'fatal', fullSweepDue: false };
    }
    return { kind: 'skipped', fullSweepDue: false };
  }

  const body = parseJson<ManifestResponse>(res);
  if (!body || !Array.isArray(body.files)) {
    // Fatal, unlike a per-batch status rejection: a hub that answers 200
    // with a body we cannot read is not a hub we can talk to at all, and a
    // silent exit 0 would report a healthy push that never happened.
    pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} err=manifest body unparseable`);
    return { kind: 'fatal', fullSweepDue: false };
  }
  if (body.host && !ctx.host) ctx.host = body.host;

  const byRel = new Map(batch.map((f) => [f.rel, f]));
  for (const entry of body.files) {
    if (!budgetLeft(ctx)) break;
    const local = byRel.get(entry.path);
    if (!local) continue;
    await pushFile(ctx, vr, local, entry.offset, entry.reset === true, opts);
  }
  const refused = readRefusal(body);
  return { kind: 'ok', fullSweepDue: body.fullSweepDue === true, ...(refused ? { refused } : {}) };
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
  // D1: the first chunk of a RESUMED append proves its prefix. Re-armed after
  // a size-driven 409, whose new offset is a new claim about the same bytes.
  let prefixPending = true;
  // One prefix-driven reset per file per run — a second means the hub and the
  // file disagree faster than we can re-read, so leave it to the next run.
  let prefixReset = false;

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
      const prefix = prefixPending && offset > 0 && !reset ? hashFilePrefix(local.abs, offset) : null;
      const meta: AppendMeta = {
        ...(cwd ? { cwd } : {}),
        ...(cwd && key ? { key } : {}),
        ...(local.named && opts.hook ? { hook: opts.hook } : {}),
        ...(final ? { final: true } : {}),
        ...(reset && firstChunk ? { reset: true } : {}),
        ...(prefix !== null ? { prefix } : {}),
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
        res = await hubRequest(ctx.hubUrl, {
          method: 'PUT', path, token: ctx.token, headers, body, timeoutMs: reqTimeout(ctx),
        });
      } catch (e) {
        ctx.result.failed++;
        const reason = (e as HubTransportError).reason ?? (e as Error).message;
        pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=unreachable ${reason}`);
        return;
      }
      if (res.status === 409) {
        const conflict409 = parseJson<AppendConflictResponse>(res);
        // D1: the hub holds DIFFERENT bytes under our offset — its mirror is
        // an old-format prefix and our file was rewritten in place. Start the
        // file over. This is NOT the one-shot `recovered` path: a prefix
        // mismatch can follow a size recovery, so it has its own guard.
        if (conflict409?.prefixMismatch === true) {
          if (prefixReset) {
            ctx.result.failed++;
            pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=prefix mismatch twice`);
            return;
          }
          prefixReset = true;
          reset = true;
          offset = 0;
          firstChunk = true;
          prefixPending = false;
          try { size = statSync(local.abs).size; } catch { return; }
          continue;
        }
        // The hub moved on (a concurrent pusher, or a reset we did not see).
        // Re-read its size and continue from there ONCE; a second 409 is a
        // real disagreement — log and let the next run re-offer the file.
        if (recovered) {
          ctx.result.failed++;
          pushLog(`${nowIso()} push-failed host=${ctx.host} vendor=${vr.vendor} path=${local.rel} err=409 twice`);
          return;
        }
        recovered = true;
        const hubSize = typeof conflict409?.size === 'number' ? conflict409.size : 0;
        offset = hubSize;
        firstChunk = false;
        reset = false;
        prefixPending = true;
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
      prefixPending = false;
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
  /**
   * Refusals the hub reports for this host, from the FIRST manifest reply
   * (D5). NULL exactly when `bytes` is null — the hub was never successfully
   * asked, so "no refusals" would be a claim we cannot make.
   */
  refused: RefusalReport | null;
  /** Set when the hub could not be asked. */
  error?: string;
}

const NO_REFUSALS: RefusalReport = { count: 0, recent: [] };

/**
 * Ask the hub what it is missing WITHOUT pushing anything: the same recent-set
 * manifest a normal run sends, summed as `size - offset`. Doctor-only — it
 * needs a hub round-trip, which is why `recall status` does not report it.
 */
export async function computePendingBytes(): Promise<PendingBytes> {
  const sat = readSatelliteConfig();
  if (!sat) return { bytes: null, files: 0, refused: null, error: 'not a satellite' };
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let bytes = 0;
  let files = 0;
  let refused: RefusalReport | undefined;
  for (const vr of vendorRoots()) {
    let swept: string[] = [];
    try { swept = await glob(vendorPattern(vr), { nodir: true }); } catch { continue; }
    // The SAME entry builder the real push uses (head included): the probe
    // must not describe a file differently from the run it predicts.
    const batch: WireManifestFile[] = [];
    const sizes = new Map<string, number>();
    for (const abs of swept) {
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const rel = relFor(vr.root, abs);
      sizes.set(rel, st.size);
      batch.push(manifestEntry(abs, rel, st.size, Math.floor(st.mtimeMs)));
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
      return { bytes: null, files: 0, refused: null, error: (e as Error).message };
    }
    if (res.status !== 200) return { bytes: null, files: 0, refused: null, error: `manifest replied ${res.status}` };
    const body = parseJson<ManifestResponse>(res);
    if (!body || !Array.isArray(body.files)) return { bytes: null, files: 0, refused: null, error: 'manifest body unparseable' };
    if (refused === undefined) refused = readRefusal(body) ?? NO_REFUSALS;
    for (const entry of body.files) {
      const size = sizes.get(entry.path);
      if (size === undefined) continue;
      const delta = entry.reset ? size : size - entry.offset;
      if (delta > 0) { bytes += delta; files++; }
    }
  }
  return { bytes, files, refused: refused ?? NO_REFUSALS };
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
