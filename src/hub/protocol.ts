/**
 * protocol — the FROZEN satellite↔hub wire contract (spec §2.3, §6).
 *
 * Pure: no I/O, no filesystem, no process state. Both sides import it — the
 * hub daemon (unit U2) to validate what arrives, the satellite (unit U3) to
 * build what it sends — so a change here is a change to BOTH ends and must be
 * accompanied by a `WIRE_VERSION` bump (S13: compatibility is gated by the
 * wire version, not by semver; the package is 0.x and every 0.x release
 * shares major 0).
 *
 * @module hub/protocol
 */

// ---------------------------------------------------------------------------
// Version + grammars
// ---------------------------------------------------------------------------

/** Bumped on any incompatible change to §2.3. Travels on every request. */
export const WIRE_VERSION = 1;

/** Satellite host name, as bound to a token on the hub. */
export const HOST_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Project key grammar (spec §4, S4): the three prefixed key classes. */
export const KEY_RE = /^(git:[0-9a-f]{40}|origin:\S+|path:.+)$/;

/**
 * Transcript path relative to its vendor root. Any Unicode segment is legal;
 * control characters and empty segments are not, and the file must be a
 * `.jsonl`. Segment-level rules (`.`, `..`, drive letters, the vendor prefix)
 * are enforced by `validateRelPath`, not by this regex.
 */
export const REL_PATH_RE = /^[^\x00-\x1f\/]+(\/[^\x00-\x1f\/]+)*\.jsonl$/u;

/** The only `--` flags a proxied query may carry (`--context` is stripped). */
export const QUERY_FLAG_ALLOWLIST = new Set<string>([
  '--limit', '--offset', '--since', '--until', '--all', '--reverse',
  '--recent', '--raw', '--raw-messages', '--no-idf', '--list',
]);

/** Positionals that would run an installer/maintenance path on the hub. */
export const REJECTED_POSITIONALS = new Set<string>([
  'install', 'uninstall', 'doctor', 'repair', 'status', 'backfill',
  'statusline', 'hub', 'push',
]);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_MANIFEST_FILES = 1000;
export const MAX_MANIFEST_BODY = 256 * 1024;
export const MAX_APPEND_BYTES = 8 * 1024 * 1024;
export const MAX_META_BYTES = 16 * 1024;
export const MAX_QUERY_BODY = 64 * 1024;
export const MAX_ARGV = 64;
export const MAX_ARGV_STRING = 4096;

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

// LOWERCASE on purpose: these serve both as outgoing header names and as
// `req.headers[...]` lookup keys, and node:http lowercases what it receives.
export const HEADER_WIRE = 'x-recall-wire';
export const HEADER_VERSION = 'x-recall-version';
export const HEADER_META = 'x-recall-meta';
export const HEADER_STALE = 'x-recall-stale';

// ---------------------------------------------------------------------------
// Meta header codec
// ---------------------------------------------------------------------------

/** The `X-Recall-Meta` payload: the satellite's per-file identity evidence. */
export interface AppendMeta {
  /** Session cwd as the satellite saw it (absent when it found none). */
  cwd?: string;
  /** Project key derived on the satellite (absent when there is no cwd). */
  key?: string;
  /** Stop-hook classification evidence, on the `--named` file only. */
  hook?: { payloadSessionId?: string; agentId?: string; isSubagent: boolean };
  /** True on the last chunk of a file — the hub may enqueue an ingest. */
  final?: boolean;
  /** True when the hub asked for a restart from byte 0. */
  reset?: boolean;
}

/** Encode a meta object as base64url of its UTF-8 JSON. ASCII by construction. */
export function encodeMeta(obj: AppendMeta): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url');
}

/**
 * Decode an `X-Recall-Meta` header value.
 *
 * Returns an Error VALUE rather than throwing — both ends treat a malformed
 * header as a 400/skip, never as a crash.
 */
export function decodeMeta(header: string): AppendMeta | Error {
  if (typeof header !== 'string' || header.length === 0) return new Error('meta header empty');
  if (header.length > MAX_META_BYTES) return new Error('meta header too large');
  let json: string;
  try {
    const buf = Buffer.from(header, 'base64url');
    if (buf.byteLength > MAX_META_BYTES) return new Error('meta header too large');
    json = buf.toString('utf-8');
  } catch {
    return new Error('meta header is not base64url');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return new Error('meta header is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Error('meta header is not an object');
  }
  const m = parsed as Record<string, unknown>;
  if (m['cwd'] !== undefined && typeof m['cwd'] !== 'string') return new Error('meta.cwd must be a string');
  if (m['key'] !== undefined) {
    if (typeof m['key'] !== 'string') return new Error('meta.key must be a string');
    if (m['cwd'] === undefined) return new Error('meta.key without meta.cwd');
    if (!KEY_RE.test(m['key'])) return new Error('meta.key does not match the key grammar');
  }
  if (m['final'] !== undefined && typeof m['final'] !== 'boolean') return new Error('meta.final must be a boolean');
  if (m['reset'] !== undefined && typeof m['reset'] !== 'boolean') return new Error('meta.reset must be a boolean');
  if (m['hook'] !== undefined) {
    const h = m['hook'];
    if (!h || typeof h !== 'object' || Array.isArray(h)) return new Error('meta.hook must be an object');
    if (typeof (h as Record<string, unknown>)['isSubagent'] !== 'boolean') {
      return new Error('meta.hook.isSubagent must be a boolean');
    }
  }
  return parsed as AppendMeta;
}

// ---------------------------------------------------------------------------
// Relative-path validation
// ---------------------------------------------------------------------------

/**
 * Validate a DECODED transcript path relative to its vendor root.
 *
 * Containment against `remoteRoot()` is the hub's separate concern (it needs
 * the filesystem); this is the pure grammar half both ends share.
 */
export function validateRelPath(
  vendor: string,
  rel: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof vendor !== 'string' || (vendor !== 'claude' && vendor !== 'codex')) {
    return { ok: false, reason: 'vendor must be claude or codex' };
  }
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'path is empty' };
  if (rel.startsWith('/')) return { ok: false, reason: 'path must not be absolute' };
  if (rel.includes('?')) return { ok: false, reason: 'path must not contain ?' };
  if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: 'path must not carry a drive letter' };
  if (!REL_PATH_RE.test(rel)) return { ok: false, reason: 'path is not a control-character-free .jsonl path' };
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '..') return { ok: false, reason: 'path must not contain . or .. segments' };
  }
  const prefix = vendor === 'claude' ? 'projects/' : 'sessions/';
  if (!rel.startsWith(prefix)) return { ok: false, reason: `path must begin with ${prefix}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Endpoint request/response shapes
// ---------------------------------------------------------------------------

export type HubVendor = 'claude' | 'codex';

/** `GET /v1/health` */
export interface HealthResponse {
  ok: true;
  version: string;
  wire: number;
  hub: string;
  runtime: { binary: boolean; model: boolean };
}

/** `POST /v1/push/manifest` */
export interface ManifestRequest {
  vendor: HubVendor;
  full: boolean;
  files: Array<{ path: string; size: number; mtime: number }>;
}

export interface ManifestResponse {
  host: string;
  fullSweepDue: boolean;
  files: Array<{ path: string; offset: number; reset?: true }>;
}

/** `PUT /v1/push/append?vendor=&path=&offset=` */
export interface AppendResponse {
  size: number;
}

/** `POST /v1/query` */
export interface QueryRequest {
  argv: string[];
  cwd: string;
  key?: string;
  host?: string;
}

export interface QueryResponse {
  stdout: string;
  stderr: string;
  exit: number;
}
