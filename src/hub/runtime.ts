/**
 * Hub runtime records — `run/hub.json` (daemon ownership), `run/hub-hosts.json`
 * (per-host activity) and `logs/hub.log` (spec §2.1).
 *
 * `hub.json` copies the install.lock semantics (preflight.ts): created with
 * `wx`, a verifiably LIVE owner is never stolen (EPERM counts as alive), a
 * heartbeat refreshes `ts`, and release only unlinks when BOTH pid and the
 * random ownership nonce match. `lockToken` is that nonce — bearer tokens
 * never appear in this file, the log, or status output.
 *
 * @module hub/runtime
 */

import {
  appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logsDir, runDir } from '../paths.js';
import { getVersion as packageVersion } from '../version.js';

// ---------------------------------------------------------------------------
// Shared atomic write (query-embed-coordinator.ts:175-179 idiom)
// ---------------------------------------------------------------------------

/** tmp in the same directory + rename, mode 0600. Creates the directory. */
export function atomicWriteFile(dest: string, contents: string): void {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, dest);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// hub.log
// ---------------------------------------------------------------------------

export function hubLogPath(): string {
  return join(logsDir(), 'hub.log');
}

/** One ISO-prefixed line per event. Append-only. Never a token. Never throws. */
export function hubLog(line: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(hubLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never take the daemon down */ }
}

// ---------------------------------------------------------------------------
// hub.json
// ---------------------------------------------------------------------------

export interface HubRecord {
  pid: number;
  bind: string;
  port: number;
  startedAt: string;
  lockToken: string;
  /** Heartbeat timestamp (ms) — refreshed every minute while the daemon lives. */
  ts: number;
  /** Resolved `server.address().address` (set once listening). */
  address?: string;
  v: 1;
}

export function hubRecordPath(): string {
  return join(runDir(), 'hub.json');
}

export function readHubRecord(): HubRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(hubRecordPath(), 'utf-8')) as HubRecord;
    return parsed && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but this user cannot signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is a hub daemon live according to `hub.json`? */
export function hubDaemonAlive(): { alive: boolean; record: HubRecord | null } {
  const record = readHubRecord();
  if (!record) return { alive: false, record: null };
  return { alive: pidAlive(record.pid), record };
}

const STALE_RECORD_MS = 60 * 60 * 1000;

/** Ownership of `hub.json` for THIS daemon's tenure. */
export class HubLock {
  private token: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private bind = '';
  private port = 0;
  private address: string | undefined;
  private startedAt = '';

  /**
   * `wx` create. A live owner is never stolen; a dead owner's record is
   * overwritten; an unreadable record is only overwritten when older than an
   * hour (install.lock semantics).
   */
  acquire(bind: string, port: number): { ok: true } | { ok: false; existingPid?: number } {
    mkdirSync(runDir(), { recursive: true });
    this.token = randomBytes(8).toString('hex');
    this.bind = bind;
    this.port = port;
    this.startedAt = new Date().toISOString();
    const body = this.body();
    try {
      writeFileSync(hubRecordPath(), body, { flag: 'wx' });
      return { ok: true };
    } catch {
      const existing = readHubRecord();
      if (existing && pidAlive(existing.pid)) {
        this.token = null;
        return { ok: false, existingPid: existing.pid };
      }
      if (!existing) {
        try {
          const ageMs = Date.now() - statSync(hubRecordPath()).mtimeMs;
          if (ageMs < STALE_RECORD_MS) { this.token = null; return { ok: false }; }
        } catch { /* vanished mid-check — claim */ }
      }
      writeFileSync(hubRecordPath(), body);
      return { ok: true };
    }
  }

  /** Rewrite in place with the RESOLVED port (`--port 0`) and address, same pid + token. */
  updatePort(port: number, address?: string): void {
    if (!this.token) return;
    this.port = port;
    this.address = address;
    writeFileSync(hubRecordPath(), this.body());
  }

  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      try {
        if (this.ownsRecord()) writeFileSync(hubRecordPath(), this.body());
      } catch { /* best-effort */ }
    }, 60_000);
    this.heartbeat.unref();
  }

  /** Unlink only when pid AND token match — never a successor's record. */
  release(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try {
      if (this.ownsRecord()) unlinkSync(hubRecordPath());
    } catch { /* ignore */ }
    this.token = null;
  }

  get lockToken(): string | null { return this.token; }

  private ownsRecord(): boolean {
    const existing = readHubRecord();
    return !!existing && existing.pid === process.pid && !!this.token && existing.lockToken === this.token;
  }

  private body(): string {
    const record: HubRecord = {
      pid: process.pid, bind: this.bind, port: this.port, startedAt: this.startedAt,
      lockToken: this.token ?? '', ts: Date.now(), ...(this.address ? { address: this.address } : {}), v: 1,
    };
    return JSON.stringify(record);
  }
}

// ---------------------------------------------------------------------------
// hub-hosts.json
// ---------------------------------------------------------------------------

export interface HostRecord {
  lastPushAt?: string;
  lastQueryAt?: string;
  lastFullManifestAt?: string;
  refusedCollisions: number;
}

export type HostRecords = Record<string, HostRecord>;

export function hubHostsPath(): string {
  return join(runDir(), 'hub-hosts.json');
}

export function readHostRecords(): HostRecords {
  try {
    const parsed = JSON.parse(readFileSync(hubHostsPath(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HostRecords = {};
    for (const [host, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      out[host] = {
        ...(typeof r['lastPushAt'] === 'string' ? { lastPushAt: r['lastPushAt'] } : {}),
        ...(typeof r['lastQueryAt'] === 'string' ? { lastQueryAt: r['lastQueryAt'] } : {}),
        ...(typeof r['lastFullManifestAt'] === 'string' ? { lastFullManifestAt: r['lastFullManifestAt'] } : {}),
        refusedCollisions: typeof r['refusedCollisions'] === 'number' ? r['refusedCollisions'] : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Read → patch → atomic write. The patch sees the current record. */
export function updateHostRecord(host: string, patch: (current: HostRecord) => HostRecord): HostRecord {
  const all = readHostRecords();
  const current = all[host] ?? { refusedCollisions: 0 };
  const next = patch(current);
  all[host] = next;
  atomicWriteFile(hubHostsPath(), JSON.stringify(all, null, 2) + '\n');
  return next;
}

/** Package version as the bundle sees it — the build-time define, else the
 *  package.json fallback (spec §6). */
export function readPackageVersion(): string {
  return packageVersion();
}
