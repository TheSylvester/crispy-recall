/**
 * Query-Embed Coordinator — daemonless cross-process single-flight for QUERY
 * embeddings.
 *
 * Problem: separate `recall "query"` CLI processes each embed one text through
 * their own in-process mutex (embedder.ts withEmbedMutex), so a burst of N
 * concurrent searches loads the embedding model N times (~0.9 GiB RSS +
 * ~1.3 GiB transient VRAM each). This module coalesces an overlapping burst
 * into at most one query-model load per batch — with NO installed service,
 * broker, listener, or resident process. The winning CLI invocation leads only
 * while it is alive; everything terminates and cleans up when the participating
 * invocations finish.
 *
 * Protocol (filesystem-based, cross-platform, under `runDir()/query-embed/`):
 *
 *   1. Every caller atomically writes `req-<token>.json` (random token, PID,
 *      embedding identity, query text; mode 0600).
 *   2. Callers compete for `leader.lock` via atomic O_EXCL (`wx`) create. The
 *      lock body carries PID + a random ownership token; release verifies both.
 *   3. The leader waits a short coalescing window, collects compatible pending
 *      requests (same embedding identity, requester still alive, no response
 *      yet), dedups exact texts, and embeds them in ONE one-shot
 *      `llama-embedding` invocation (embedBatchOneShot — pinned; never
 *      llama-server). It re-verifies lock ownership immediately before each
 *      model spawn so a reaped/stolen lock can never yield two concurrent
 *      loads.
 *   4. Responses are written atomically (`res-<token>.json`) and request files
 *      deleted only AFTER their response is durable — so a replacement leader
 *      can recover a crashed leader's batch by replaying the surviving
 *      requests.
 *   5. The leader drains late arrivals in bounded rounds, then releases
 *      leadership (verified unlink).
 *   6. Followers poll only for their own response; when the lock disappears or
 *      its owner is verifiably dead they re-attempt leadership. Stale-leader
 *      reaping is TOCTOU-safe: rename the suspect lock to a reaper-unique
 *      name, verify the RENAMED file's owner is dead, delete it, and only the
 *      successful renamer may create the replacement lock. Two followers
 *      racing the same dead lock therefore elect exactly one leader (rename of
 *      a missing source fails for the loser). If the rename accidentally
 *      captured a LIVE leader's fresh lock, it is restored via `wx` (and on a
 *      restore race the stolen-from leader abdicates at its next pre-spawn
 *      ownership check).
 *   7. On bounded terminal failure the caller THROWS — dualPathSearch degrades
 *      to FTS-only. Followers never fall back to direct embedding (that would
 *      recreate the model storm).
 *   8. Stale/corrupt artifacts are swept on entry; each caller removes its own
 *      request/response on exit. After a hard kill (SIGKILL/power loss) inert
 *      files may transiently survive — the next invocation reaps them; no
 *      PROCESS ever survives, because the only child is the self-terminating
 *      one-shot llama-embedding.
 *
 * Plaintext query text lives only in the request file for the active request
 * lifecycle (deleted on completion, swept when stale). No vector cache is
 * kept.
 *
 * The hours-long `embed.lock` (embed-lock.ts) belongs to the BACKGROUND drain
 * election and is deliberately not touched here: interactive queries must not
 * wait behind a multi-hour backfill, and the guarantee this module makes is at
 * most one QUERY model load per overlapping batch — a background drain's
 * server is a separate, pre-existing resource budget.
 *
 * @module recall/query-embed-coordinator
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../paths.js';
import { readEmbedderConfig } from '../installer/config.js';
import { EMBED_VERSION } from './embed-config.js';
import { embedBatchOneShot, getModelPath } from './embedder.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Tunables — env overrides exist for tests only (subprocess fleets need to
// widen the coalescing window for a deterministic single batch).
// ---------------------------------------------------------------------------

const EXPECTED_DIMS = 768;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Coalescing window the leader waits before collecting the batch. */
const COALESCE_MS = () => envInt('RECALL_QE_COALESCE_MS', 25);
/** Follower poll interval while waiting for a response / the lock. */
const POLL_MS = () => envInt('RECALL_QE_POLL_MS', 15);
/** Total budget a caller waits before giving up (throw → FTS-only). */
const RESPONSE_TIMEOUT_MS = () => envInt('RECALL_QE_RESPONSE_TIMEOUT_MS', 180_000);
/** Compute deadline for one one-shot embed child (model load included). */
const EMBED_TIMEOUT_MS = () => envInt('RECALL_QE_EMBED_TIMEOUT_MS', 300_000);
/** Max wall-clock a leadership tenure may keep STARTING new rounds. One
 *  in-flight embed may still run up to EMBED_TIMEOUT_MS beyond this, so the
 *  hard tenure ceiling is MAX_TENURE_MS + EMBED_TIMEOUT_MS. */
const MAX_TENURE_MS = () => envInt('RECALL_QE_MAX_TENURE_MS', 120_000);
/**
 * A leader lock older than this is reapable even if its PID looks alive —
 * PIDs are recycled, so age is the backstop for a reused-PID false positive.
 * INVARIANT: this must exceed the hard tenure ceiling (MAX_TENURE_MS +
 * EMBED_TIMEOUT_MS) with margin, or a legitimate live leader could be reaped
 * mid-embed and a second model load spawned — the floor below enforces that
 * relationship even under env overrides.
 */
const LOCK_MAX_AGE_MS = () =>
  Math.max(
    envInt('RECALL_QE_LOCK_MAX_AGE_MS', 10 * 60_000),
    MAX_TENURE_MS() + EMBED_TIMEOUT_MS() + 60_000,
  );
/** Artifacts (req/res/tmp/reap) older than this are swept on entry. */
const STALE_ARTIFACT_MS = 10 * 60_000;
/** Max texts per ROUND (one one-shot invocation per round) — bounds a single
 *  round's runtime to one EMBED_TIMEOUT_MS; leftovers roll to the next round,
 *  where the tenure check runs. */
const MAX_BATCH_TEXTS = 64;
/** Max drain rounds one leadership tenure may run before abdicating. */
const MAX_DRAIN_ROUNDS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestFile {
  v: 1;
  token: string;
  pid: number;
  identity: string;
  text: string;
  createdAt: number;
}

interface ResponseFile {
  v: 1;
  token: string;
  ok: boolean;
  vector?: number[];
  error?: string;
}

interface LeaderLock {
  v: 1;
  pid: number;
  token: string;
  acquiredAt: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function qeDir(): string {
  return join(runDir(), 'query-embed');
}

function lockPath(dir: string): string {
  return join(dir, 'leader.lock');
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write atomically: temp file in the same dir, then rename. Mode 0600. */
function atomicWrite(dir: string, dest: string, contents: string): void {
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, dest);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The embedding identity: callers with different model/config/version must
 * never co-batch (their vectors would be incomparable). Hashed so no config
 * detail leaks into artifact names.
 */
export function embedIdentity(): string {
  const cfg = readEmbedderConfig();
  return createHash('sha256')
    .update(JSON.stringify({
      model: getModelPath(),
      mode: cfg.mode,
      ngl: cfg.mode === 'gpu' ? cfg.ngl : 0,
      embedVersion: EMBED_VERSION,
      dims: EXPECTED_DIMS,
    }))
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Signal cleanup — release the lock / remove own artifacts on SIGINT/SIGTERM
// so an interactive ^C doesn't leave a live-looking lock behind. Installed
// lazily on first coordination (query path only — never on import, so the
// backfill CLI's own SIGINT handling is unaffected).
// ---------------------------------------------------------------------------

interface ActiveCoordination { dir: string; token: string }

const active = new Set<ActiveCoordination>();
let signalsInstalled = false;

function ensureSignalHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const handler = (sig: 'SIGINT' | 'SIGTERM') => {
    for (const a of active) {
      try { unlinkSync(join(a.dir, `req-${a.token}.json`)); } catch { /* best-effort */ }
      try { unlinkSync(join(a.dir, `res-${a.token}.json`)); } catch { /* best-effort */ }
      releaseLeadership(a.dir, a.token);
    }
    active.clear();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Entry sweep — reap inert crash remnants safely
// ---------------------------------------------------------------------------

function sweepStaleArtifacts(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (name === 'leader.lock') continue; // handled by the reap protocol
    const p = join(dir, name);
    const isArtifact = name.startsWith('req-') || name.startsWith('res-')
      || name.startsWith('.tmp-') || name.startsWith('leader.reap-');
    if (!isArtifact) continue;
    try {
      const age = now - statSync(p).mtimeMs;
      if (name.startsWith('req-') || name.startsWith('res-')) {
        const body = readJson<RequestFile | ResponseFile>(p);
        const ownerPid = body && 'pid' in body ? (body as RequestFile).pid : null;
        // req files carry the requester pid; res files don't — a response is
        // keyed by its request token, so it is stale once its req is gone AND
        // it has aged past the grace window (its requester consumed-or-died).
        if (body === null && age > 30_000) {
          unlinkSync(p); // corrupt beyond parse — writes are atomic, safe to drop
        } else if (ownerPid !== null && !isAlive(ownerPid) && age > 5_000) {
          unlinkSync(p);
        } else if (age > STALE_ARTIFACT_MS) {
          unlinkSync(p);
        }
      } else if (age > 60_000) {
        unlinkSync(p); // orphaned tmp/reap file
      }
    } catch { /* raced another sweeper — fine */ }
  }
}

// ---------------------------------------------------------------------------
// Leadership
// ---------------------------------------------------------------------------

function tryAcquireLeadership(dir: string, myToken: string): boolean {
  const lp = lockPath(dir);
  const body = JSON.stringify({
    v: 1, pid: process.pid, token: myToken, acquiredAt: Date.now(),
  } satisfies LeaderLock);
  try {
    writeFileSync(lp, body, { flag: 'wx', mode: 0o600 });
    return true;
  } catch { /* held — fall through to staleness check */ }

  const owner = readJson<LeaderLock>(lp);
  if (owner && isAlive(owner.pid) && Date.now() - (owner.acquiredAt ?? 0) < LOCK_MAX_AGE_MS()) {
    return false; // legitimate live leader
  }
  if (!existsSync(lp)) return false; // vanished mid-check — retry next poll
  return reapAndAcquire(dir, myToken, body);
}

/**
 * TOCTOU-safe reap of a suspect (dead/corrupt/overaged) leader lock.
 * Atomic claim: rename to a reaper-unique name → verify the RENAMED file →
 * delete → only the successful renamer creates the replacement lock.
 */
function reapAndAcquire(dir: string, myToken: string, myBody: string): boolean {
  const lp = lockPath(dir);
  const reapPath = join(dir, `leader.reap-${myToken}`);
  try {
    renameSync(lp, reapPath);
  } catch {
    return false; // another reaper won, or the leader released — re-poll
  }
  const renamed = readJson<LeaderLock>(reapPath);
  if (renamed && isAlive(renamed.pid) && Date.now() - (renamed.acquiredAt ?? 0) < LOCK_MAX_AGE_MS()) {
    // We captured a LIVE leader's fresh lock (raced a re-acquire between our
    // read and rename). Restore it; if a third party created a new lock in the
    // gap, the stolen-from leader abdicates at its next ownership check.
    try { writeFileSync(lp, JSON.stringify(renamed), { flag: 'wx', mode: 0o600 }); } catch { /* superseded */ }
    try { unlinkSync(reapPath); } catch { /* best-effort */ }
    return false;
  }
  try { unlinkSync(reapPath); } catch { /* best-effort */ }
  try {
    writeFileSync(lp, myBody, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false; // someone else claimed in the gap — one leader either way
  }
}

/** Do we still own the leader lock? Verified by PID + token, never PID alone. */
function stillLeader(dir: string, myToken: string): boolean {
  const owner = readJson<LeaderLock>(lockPath(dir));
  return !!owner && owner.pid === process.pid && owner.token === myToken;
}

/** Release the lock ONLY if pid + token both still match ours. */
function releaseLeadership(dir: string, myToken: string): void {
  try {
    if (stillLeader(dir, myToken)) unlinkSync(lockPath(dir));
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Leader batch loop
// ---------------------------------------------------------------------------

interface PendingRequest { path: string; req: RequestFile }

/** Collect replayable requests compatible with `identity` (no response yet,
 *  requester alive). Dead requesters' requests are removed. */
function collectPending(dir: string, identity: string): PendingRequest[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: PendingRequest[] = [];
  for (const name of names) {
    if (!name.startsWith('req-') || !name.endsWith('.json')) continue;
    const p = join(dir, name);
    const req = readJson<RequestFile>(p);
    if (!req || typeof req.text !== 'string' || typeof req.token !== 'string') {
      try { unlinkSync(p); } catch { /* raced */ }
      continue;
    }
    if (req.identity !== identity) continue; // different model/config — never co-batch
    if (!isAlive(req.pid)) {
      try { unlinkSync(p); } catch { /* raced */ }
      continue;
    }
    if (existsSync(join(dir, `res-${req.token}.json`))) continue; // already answered
    out.push({ path: p, req });
  }
  return out;
}

function writeResponse(dir: string, token: string, res: Omit<ResponseFile, 'v' | 'token'>): void {
  atomicWrite(dir, join(dir, `res-${token}.json`), JSON.stringify({ v: 1, token, ...res }));
}

/**
 * Lead: coalesce → embed (ONE one-shot invocation per round, ≤MAX_BATCH_TEXTS
 * texts) → respond → drain late arrivals, bounded by rounds AND tenure.
 * Returns our own vector once our request has been served, or null if we
 * abdicated before serving it.
 *
 * Tenure bound: no new round starts after MAX_TENURE_MS, so a live tenure can
 * never approach LOCK_MAX_AGE_MS (hard ceiling = MAX_TENURE_MS + one
 * EMBED_TIMEOUT_MS, enforced < LOCK_MAX_AGE_MS by the floor above). Without
 * this, a long-lived legitimate leader could look "over-age" to a follower's
 * reaper mid-embed and a second concurrent model load would spawn.
 */
async function leadBatches(
  dir: string,
  myToken: string,
  identity: string,
): Promise<Float32Array | null> {
  let ownVector: Float32Array | null = null;
  const tenureDeadline = Date.now() + MAX_TENURE_MS();
  await sleep(COALESCE_MS());

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    if (Date.now() >= tenureDeadline) {
      log({
        source: 'recall:query-embed',
        level: 'warn',
        summary: 'query-embed leader hit its tenure bound — abdicating (remaining requesters re-elect)',
      });
      return ownVector;
    }
    const pending = collectPending(dir, identity);
    if (pending.length === 0) return ownVector;

    // Re-verify ownership immediately before the expensive/model-loading step:
    // if our lock was reaped (or superseded), abdicate WITHOUT spawning so at
    // most one query model process exists at any moment.
    if (!stillLeader(dir, myToken)) return ownVector;

    // One invocation per round; overflow rolls to the next round (where the
    // tenure/ownership checks run again).
    const texts = [...new Set(pending.map((p) => p.req.text))].slice(0, MAX_BATCH_TEXTS);
    let vectors: Float32Array[];
    try {
      vectors = await embedBatchOneShot(texts, { timeoutMs: EMBED_TIMEOUT_MS() });
      for (const v of vectors) {
        if (v.length !== EXPECTED_DIMS) {
          throw new Error(`query embed returned ${v.length} dims (expected ${EXPECTED_DIMS})`);
        }
      }
    } catch (e) {
      // Bounded terminal failure: answer every pending follower with the error
      // so they fail fast to FTS-only instead of re-electing and re-storming,
      // then rethrow for ourselves.
      const msg = e instanceof Error ? e.message : String(e);
      for (const p of pending) {
        if (p.req.token === myToken) continue;
        try { writeResponse(dir, p.req.token, { ok: false, error: msg }); } catch { /* best-effort */ }
        try { unlinkSync(p.path); } catch { /* best-effort */ }
      }
      throw e;
    }

    const byText = new Map<string, Float32Array>();
    texts.forEach((t, i) => byText.set(t, vectors[i]!));

    for (const p of pending) {
      const v = byText.get(p.req.text);
      if (!v) continue; // overflow text — served in a later round
      if (p.req.token === myToken) {
        ownVector = v;
      } else {
        writeResponse(dir, p.req.token, { ok: true, vector: Array.from(v) });
      }
      // Delete the request only AFTER its response is durable (atomic rename
      // above) — a replacement leader can replay anything still on disk.
      try { unlinkSync(p.path); } catch { /* best-effort */ }
    }
    // Loop: drain arrivals that landed while we were embedding.
  }
  log({
    source: 'recall:query-embed',
    level: 'warn',
    summary: `query-embed leader hit the ${MAX_DRAIN_ROUNDS}-round drain bound — abdicating (remaining requesters re-elect)`,
  });
  return ownVector;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed ONE query text with cross-process burst coalescing. Throws on bounded
 * terminal failure (caller degrades to FTS-only). Never engages llama-server;
 * never leaves a process, lock, request, or response behind on a clean exit.
 */
export async function coordinatedQueryEmbed(text: string): Promise<Float32Array> {
  const dir = qeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStaleArtifacts(dir);
  ensureSignalHandlers();

  const token = randomBytes(9).toString('hex');
  const identity = embedIdentity();
  const reqPath = join(dir, `req-${token}.json`);
  const resPath = join(dir, `res-${token}.json`);
  const me: ActiveCoordination = { dir, token };

  atomicWrite(dir, reqPath, JSON.stringify({
    v: 1, token, pid: process.pid, identity, text, createdAt: Date.now(),
  } satisfies RequestFile));
  active.add(me);

  try {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS();
    while (Date.now() < deadline) {
      // 1. Someone answered us.
      const res = existsSync(resPath) ? readJson<ResponseFile>(resPath) : null;
      if (res) {
        if (!res.ok) throw new Error(res.error ?? 'query embed failed in coordinating leader');
        if (!Array.isArray(res.vector) || res.vector.length !== EXPECTED_DIMS) {
          throw new Error(`query embed response malformed (${res.vector?.length ?? 'no'} dims)`);
        }
        return Float32Array.from(res.vector);
      }

      // 2. Try to lead (also covers: lock absent, or owner verifiably dead).
      if (tryAcquireLeadership(dir, token)) {
        try {
          const own = await leadBatches(dir, token, identity);
          if (own) return own;
          // Abdicated before serving ourselves (round bound) — loop as follower.
        } finally {
          releaseLeadership(dir, token);
        }
        continue;
      }

      await sleep(POLL_MS());
    }
    throw new Error(`query embed timed out after ${RESPONSE_TIMEOUT_MS()}ms waiting for the coordinator`);
  } finally {
    active.delete(me);
    try { unlinkSync(reqPath); } catch { /* usually already deleted by the leader */ }
    try { unlinkSync(resPath); } catch { /* usually consumed */ }
  }
}
