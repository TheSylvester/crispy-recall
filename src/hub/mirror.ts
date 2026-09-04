/**
 * Mirror path helper, append and sidecar (spec §2.3 "Path rules", "Mirror
 * path helper", "Append semantics"; §2.4 step 1).
 *
 * Every mirror path string is built with `transcriptGlob` — the same helper
 * the sweep uses for its glob pattern — so the watermark key written by the
 * push handler is byte-identical to the `glob()` result the sweep compares
 * against. No `path.join`, no `realpath`, no trailing separator.
 *
 * @module hub/mirror
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, writeSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { remoteRoot, transcriptGlob } from '../paths.js';
import type { MirrorMeta } from '../recall/mirror-meta.js';
import { type HubVendor, validateRelPath } from './protocol.js';
import { atomicWriteFile } from './runtime.js';

/** `<remoteRoot()>/<host>/<vendor>` — the vendor root the sweep globs from. */
export function mirrorVendorRoot(host: string, vendor: HubVendor): string {
  return transcriptGlob(remoteRoot(), host, vendor);
}

/** `<remoteRoot()>/<host>/<vendor>/<rel>` — the on-disk mirror file. */
export function mirrorFilePath(host: string, vendor: HubVendor, rel: string): string {
  return transcriptGlob(remoteRoot(), host, vendor, rel);
}

/** `<remoteRoot()>/<host>/` prefix (forward slashes) for provenance containment. */
export function mirrorHostPrefix(host: string): string {
  return transcriptGlob(remoteRoot(), host) + '/';
}

export interface MirrorRoot { root: string; vendor: HubVendor }

/** One entry per EXISTING `<remoteRoot()>/<host>/<vendor>` directory. */
export function mirrorRoots(): MirrorRoot[] {
  const out: MirrorRoot[] = [];
  for (const host of mirrorHosts()) {
    for (const vendor of ['claude', 'codex'] as const) {
      const root = mirrorVendorRoot(host, vendor);
      try {
        if (statSync(root).isDirectory()) out.push({ root, vendor });
      } catch { /* absent */ }
    }
  }
  return out;
}

/** Host directories under `remoteRoot()`, sorted. Empty when the root is absent. */
export function mirrorHosts(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(remoteRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return entries.sort();
}

export interface ResolvedMirrorPath { ok: true; rel: string; abs: string }
export interface RejectedMirrorPath { ok: false; reason: string }

/**
 * Path rules + containment on the DECODED path. Normalizes `\` → `/` FIRST
 * so the validated string is exactly the one `mirrorFilePath` produces
 * (transcriptGlob strips `\` too: a `projects/a\b.jsonl` would pass the
 * regex as one segment yet be written to `projects/a/b.jsonl`).
 */
export function resolveMirrorPath(host: string, vendor: HubVendor, decoded: string): ResolvedMirrorPath | RejectedMirrorPath {
  if (typeof decoded !== 'string') return { ok: false, reason: 'path missing' };
  const rel = decoded.replace(/\\/g, '/');
  const rules = validateRelPath(vendor, rel);
  if (!rules.ok) return rules;
  const root = resolve(remoteRoot(), host, vendor);
  const contained = resolve(root, rel);
  if (!contained.startsWith(root + sep)) return { ok: false, reason: 'path escapes the mirror root' };
  if (process.platform === 'darwin') {
    // Case-insensitive default filesystem: compare the real parent too.
    try {
      const realParent = realpathSync.native(dirname(contained));
      const realRoot = realpathSync.native(root);
      if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
        return { ok: false, reason: 'path escapes the mirror root' };
      }
    } catch { /* parent does not exist yet — the string check above holds */ }
  }
  return { ok: true, rel, abs: mirrorFilePath(host, vendor, rel) };
}

/** `<abs>.meta.json`, atomically (tmp + rename, 0600). */
export function writeSidecar(abs: string, meta: MirrorMeta): void {
  atomicWriteFile(`${abs}.meta.json`, JSON.stringify(meta) + '\n');
}

/** `<file>.superseded-<ISO with ':' → '-'>` */
export function supersededPath(abs: string, now: Date): string {
  return `${abs}.superseded-${now.toISOString().replace(/:/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Per-file in-memory mutex keyed on `abs`
// ---------------------------------------------------------------------------

const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(abs: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = fileLocks.get(abs) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => mine);
  fileLocks.set(abs, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(abs) === chained) fileLocks.delete(abs);
  }
}

export interface AppendOk {
  ok: true;
  size: number;
  mtimeInt: number;
  superseded?: string;
}
export interface AppendFail {
  ok: false;
  status: 400 | 409;
  size?: number;
  reason: string;
}

/**
 * Append semantics (§2.3), to be called INSIDE `withFileLock(abs)`:
 * reset → require offset 0, rename the existing file aside; stat; offset must
 * equal the current size (else 409 `{size}`); open `a`, write the whole body,
 * fsync, stat again.
 */
export function appendMirrorBytes(
  abs: string,
  body: Buffer,
  opts: { offset: number; reset: boolean; now: Date },
): AppendOk | AppendFail {
  mkdirSync(dirname(abs), { recursive: true });
  let superseded: string | undefined;
  if (opts.reset) {
    if (opts.offset !== 0) return { ok: false, status: 400, reason: 'reset requires offset=0' };
    if (existsSync(abs)) {
      superseded = supersededPath(abs, opts.now);
      renameSync(abs, superseded);
    }
  }
  let current = 0;
  try { current = statSync(abs).size; } catch { current = 0; }
  if (opts.offset !== current) return { ok: false, status: 409, size: current, reason: 'offset mismatch' };

  const fd = openSync(abs, 'a');
  try {
    let written = 0;
    while (written < body.length) {
      written += writeSync(fd, body, written, body.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const st = statSync(abs);
  return { ok: true, size: st.size, mtimeInt: Math.floor(st.mtimeMs), ...(superseded ? { superseded } : {}) };
}

// ---------------------------------------------------------------------------
// Per-host summary (status / doctor)
// ---------------------------------------------------------------------------

export interface MirrorHostSummary {
  host: string;
  files: number;
  bytes: number;
  sidecarless: number;
}

export function mirrorHostSummary(host: string): MirrorHostSummary {
  let files = 0;
  let bytes = 0;
  let sidecarless = 0;
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      files++;
      try { bytes += statSync(p).size; } catch { /* vanished */ }
      if (!existsSync(`${p}.meta.json`)) sidecarless++;
    }
  };
  walk(transcriptGlob(remoteRoot(), host));
  return { host, files, bytes, sidecarless };
}
