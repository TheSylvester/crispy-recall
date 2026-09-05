/**
 * Hub wire protocol — the shared, I/O-free half of spec §2.3 and §6.
 *
 * Both sides of the wire import this module: the hub daemon validates with
 * it, the satellite client (unit U3) builds requests with it. Every export
 * name here is FROZEN for the merge; U3 builds against a byte-compatible
 * provisional copy of this exact list.
 *
 * Compatibility is gated by `WIRE_VERSION`, not semver (S13): every 0.x
 * release shares major 0, so the package version cannot carry the signal.
 *
 * @module hub/protocol
 */

import { HEX64_RE } from './hash.js';
import type { MirrorMeta } from '../recall/mirror-meta.js';

/** Bumped on ANY incompatible change to §2.3. */
export const WIRE_VERSION = 1;

/** Satellite host name: bound to a token on the hub, part of the mirror path. */
export const HOST_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Project key (spec S4): `git:<root-commit>`, `origin:<normalized-url>`, `path:<cwd>`. */
export const KEY_RE = /^(git:[0-9a-f]{40}|origin:\S+|path:.+)$/;

/** Vendor-relative transcript path: any Unicode, forward slashes, no control chars. */
export const REL_PATH_RE = /^[^\x00-\x1f\/]+(\/[^\x00-\x1f\/]+)*\.jsonl$/u;

/** The only `--` tokens a proxied query may carry (besides the stripped `--context`). */
export const QUERY_FLAG_ALLOWLIST: Set<string> = new Set([
  '--limit', '--offset', '--since', '--until', '--all', '--reverse', '--recent',
  '--raw', '--raw-messages', '--no-idf', '--list',
]);

/** Positionals a proxied query may never carry — they are commands, not queries. */
export const REJECTED_POSITIONALS: Set<string> = new Set([
  'install', 'uninstall', 'doctor', 'repair', 'status', 'backfill', 'statusline', 'hub', 'push',
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
// Header names — LOWERCASE: used both as outgoing header names and as
// `req.headers[...]` keys, which node:http lowercases.
// ---------------------------------------------------------------------------

export const HEADER_WIRE = 'x-recall-wire';
export const HEADER_VERSION = 'x-recall-version';
export const HEADER_META = 'x-recall-meta';
export const HEADER_STALE = 'x-recall-stale';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HubVendor = 'claude' | 'codex';

/** `GET /v1/health` → 200. Unauthenticated. */
export interface HealthResponse {
  ok: true;
  version: string;
  wire: number;
  hub: string;
  runtime: { binary: boolean; model: boolean };
}

/** 426 body on a missing or mismatched `X-Recall-Wire`. */
export interface WireMismatchResponse {
  wire: number;
  version: string;
}

export interface ManifestFile {
  path: string;
  size: number;
  mtime: number;
  /**
   * sha256 of the satellite's bytes `[0, min(size, HEAD_BYTES))` (§2.3, D1).
   * OPTIONAL and additive — a pre-0.4.0-sat.3 satellite omits it and the hub
   * falls back to the size-only rules, so no `WIRE_VERSION` bump.
   */
  head?: string;
}

/** `POST /v1/push/manifest` request. */
export interface ManifestRequest {
  vendor: HubVendor;
  full: boolean;
  files: ManifestFile[];
}

export interface ManifestResponseFile {
  path: string;
  offset: number;
  reset?: true;
}

/** `POST /v1/push/manifest` → 200. */
export interface ManifestResponse {
  host: string;
  fullSweepDue: boolean;
  files: ManifestResponseFile[];
  /** Pushes of THIS host's sessions the hub refused as id collisions (D5). */
  refusedCollisions: number;
  /** Up to 5 canonical ids of those refusals, newest first. */
  refusedRecent: string[];
}

/** Decoded `X-Recall-Meta` on `PUT /v1/push/append`. */
export interface AppendMeta {
  cwd?: string;
  key?: string;
  hook?: { payloadSessionId?: string; agentId?: string; isSubagent: boolean };
  final?: boolean;
  reset?: boolean;
  /**
   * sha256 of the satellite's bytes `[0, offset)`, on the FIRST chunk of a
   * resumed append only (§2.3, D1). Optional and additive.
   */
  prefix?: string;
}

/** `PUT /v1/push/append` → 200 `{size}`; 409 `{size}` on an offset mismatch. */
export interface AppendResponse {
  size: number;
}

/** 409 body: `{size}` on an offset mismatch, plus the flag when the mirror's
 *  `[0, offset)` bytes are not the satellite's (the caller must reset). */
export interface AppendConflictResponse {
  size: number;
  prefixMismatch?: true;
}

/** `POST /v1/query` request. */
export interface QueryRequest {
  argv: string[];
  cwd: string;
  key?: string;
  host?: string;
}

/** `POST /v1/query` → 200. */
export interface QueryResponse {
  stdout: string;
  stderr: string;
  exit: number;
}

/** Generic error body on 4xx/5xx. */
export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Encode the append metadata as base64url of UTF-8 JSON — ASCII by construction. */
export function encodeMeta(obj: AppendMeta): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Decode and validate an `X-Recall-Meta` header. Returns an Error VALUE
 * (never throws) so the caller maps it to a 400 without a try/catch.
 *
 * The result is "MirrorMeta-like": the fields a sidecar carries plus the
 * per-request `final`/`reset`/`prefix` flags.
 *
 * UNKNOWN KEYS ARE IGNORED — the result is rebuilt field by field from the
 * known names, never spread from the parsed object. A newer satellite may add
 * a meta field without a `WIRE_VERSION` bump.
 */
export function decodeMeta(header: string | undefined): AppendMeta | Error {
  if (typeof header !== 'string' || header.length === 0) return new Error('X-Recall-Meta header missing');
  if (!BASE64URL_RE.test(header)) return new Error('X-Recall-Meta is not base64url');
  const buf = Buffer.from(header, 'base64url');
  if (buf.length > MAX_META_BYTES) return new Error(`X-Recall-Meta exceeds ${MAX_META_BYTES} bytes decoded`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return new Error('X-Recall-Meta is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Error('X-Recall-Meta must be a JSON object');
  const m = parsed as Record<string, unknown>;
  if (m['cwd'] !== undefined && typeof m['cwd'] !== 'string') return new Error('X-Recall-Meta cwd must be a string');
  if (m['key'] !== undefined) {
    if (typeof m['key'] !== 'string') return new Error('X-Recall-Meta key must be a string');
    if (m['cwd'] === undefined) return new Error('X-Recall-Meta key requires cwd');
    if (!KEY_RE.test(m['key'])) return new Error('X-Recall-Meta key is not a project key');
  }
  if (m['final'] !== undefined && typeof m['final'] !== 'boolean') return new Error('X-Recall-Meta final must be a boolean');
  if (m['reset'] !== undefined && typeof m['reset'] !== 'boolean') return new Error('X-Recall-Meta reset must be a boolean');
  if (m['prefix'] !== undefined) {
    if (typeof m['prefix'] !== 'string') return new Error('X-Recall-Meta prefix must be a string');
    if (!HEX64_RE.test(m['prefix'])) return new Error('X-Recall-Meta prefix must be 64 lowercase hex characters');
  }
  if (m['hook'] !== undefined) {
    const h = m['hook'];
    if (!h || typeof h !== 'object' || Array.isArray(h)) return new Error('X-Recall-Meta hook must be an object');
    const hh = h as Record<string, unknown>;
    if (typeof hh['isSubagent'] !== 'boolean') return new Error('X-Recall-Meta hook.isSubagent must be a boolean');
    if (hh['payloadSessionId'] !== undefined && typeof hh['payloadSessionId'] !== 'string') return new Error('X-Recall-Meta hook.payloadSessionId must be a string');
    if (hh['agentId'] !== undefined && typeof hh['agentId'] !== 'string') return new Error('X-Recall-Meta hook.agentId must be a string');
  }
  const out: AppendMeta = {};
  if (typeof m['cwd'] === 'string') out.cwd = m['cwd'];
  if (typeof m['key'] === 'string') out.key = m['key'];
  if (m['hook'] !== undefined) {
    const hh = m['hook'] as Record<string, unknown>;
    out.hook = {
      isSubagent: hh['isSubagent'] as boolean,
      ...(typeof hh['payloadSessionId'] === 'string' ? { payloadSessionId: hh['payloadSessionId'] } : {}),
      ...(typeof hh['agentId'] === 'string' ? { agentId: hh['agentId'] } : {}),
    };
  }
  if (m['final'] !== undefined) out.final = m['final'] as boolean;
  if (m['reset'] !== undefined) out.reset = m['reset'] as boolean;
  if (typeof m['prefix'] === 'string') out.prefix = m['prefix'];
  return out;
}

/** The sidecar body the hub persists for an append (`MirrorMeta` shape). */
export function metaToSidecar(host: string, meta: AppendMeta, updatedAt: string): MirrorMeta {
  return {
    host,
    ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
    ...(meta.key !== undefined ? { key: meta.key } : {}),
    ...(meta.hook !== undefined ? { hook: meta.hook } : {}),
    updatedAt,
    v: 1,
  };
}

/**
 * Path rules (§2.3) on the DECODED, `/`-normalized relative path. Containment
 * against the mirror root is the caller's job (it needs I/O-free `resolve`,
 * but also the host and `remoteRoot()`, which this module does not know).
 */
export function validateRelPath(
  vendor: HubVendor,
  rel: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'path missing' };
  if (rel.startsWith('/')) return { ok: false, reason: 'path must be relative' };
  if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: 'path carries a drive letter' };
  if (rel.includes('?')) return { ok: false, reason: 'path contains ?' };
  if (!REL_PATH_RE.test(rel)) return { ok: false, reason: 'path is not a .jsonl path of non-empty segments without control characters' };
  const segments = rel.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return { ok: false, reason: 'path contains a . or .. segment' };
  const prefix = vendor === 'claude' ? 'projects/' : 'sessions/';
  if (!rel.startsWith(prefix)) return { ok: false, reason: `path must begin with ${prefix} for vendor ${vendor}` };
  return { ok: true };
}

/** `vendor` query/body value → HubVendor, or null. */
export function parseVendor(v: unknown): HubVendor | null {
  return v === 'claude' || v === 'codex' ? v : null;
}
