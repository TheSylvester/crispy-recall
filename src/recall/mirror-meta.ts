/**
 * Mirror metadata — the per-file sidecar the hub writes beside every mirrored
 * satellite transcript (spec §2.4.1, S12).
 *
 * A mirrored transcript names a directory that does NOT exist on the hub, so
 * `deriveProjectKey` can never run for it. The satellite derived the key on
 * the machine that owns the repo and shipped it in `X-Recall-Meta`; the hub
 * persists it as `<transcript>.meta.json`. The sidecar is what lets the key
 * survive the mirror sweep, `backfill` and `repair --full`, all of which call
 * `ingestSessionMessages` with no options.
 *
 * Sidecars are not `.jsonl`, so the transcript globs never ingest them.
 *
 * @module recall/mirror-meta
 */

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { remoteRoot } from '../paths.js';

/** The sidecar body written beside a mirrored transcript. */
export interface MirrorMeta {
  /** Satellite host name the bytes came from. */
  host: string;
  /** Session cwd as the satellite saw it (absent when the satellite found none). */
  cwd?: string;
  /** Project key derived on the satellite (absent when there is no cwd). */
  key?: string;
  /** Hook classification evidence forwarded from the satellite Stop hook. */
  hook?: { payloadSessionId?: string; agentId?: string; isSubagent: boolean };
  updatedAt: string;
  v: 1;
}

/**
 * True when `p` lives strictly under `remoteRoot()`.
 *
 * The `+ sep` matters: without it `<recallRoot>/remote-x/a.jsonl` would be a
 * false positive on the string prefix, and a local transcript would be treated
 * as a mirror row (NULL key, no derivation).
 */
export function isUnderRemoteRoot(p: string): boolean {
  return resolve(p).startsWith(resolve(remoteRoot()) + sep);
}

/**
 * Read `<transcriptPath>.meta.json`. Tolerant: any missing file, unreadable
 * file, malformed JSON, foreign version, or non-string `key` yields `null`,
 * and the caller stamps a NULL project_key rather than guessing.
 */
export function readMirrorMeta(transcriptPath: string): MirrorMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(`${transcriptPath}.meta.json`, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  if (m['v'] !== 1) return null;
  if (m['key'] !== undefined && typeof m['key'] !== 'string') return null;
  if (m['cwd'] !== undefined && typeof m['cwd'] !== 'string') return null;
  return parsed as MirrorMeta;
}

/**
 * Merge a freshly-decoded sidecar over the one already on disk (M2).
 *
 * An append carries only what the satellite could see for THAT chunk: a push
 * whose `peekCwd` fell outside its window sends no `cwd` and no `key`, and a
 * subsequent chunk of a session whose key was already learned sends none
 * either. Writing `next` verbatim — as the hub did — erased the key from the
 * sidecar, and with it the only channel by which `repair --full`, `backfill`
 * and the mirror sweep can key a mirrored transcript at all.
 *
 * `next` never carries explicit `undefined` (metaToSidecar omits absent
 * fields), so a plain spread is exactly the rule "the incoming value wins
 * when present, the stored one survives when it is not". `host`, `updatedAt`
 * and `v` are always present on `next` and always win.
 */
export function mergeMirrorMeta(prior: MirrorMeta | null, next: MirrorMeta): MirrorMeta {
  if (prior === null) return next;
  return { ...prior, ...next };
}
