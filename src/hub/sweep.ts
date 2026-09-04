/**
 * Mirror sweep (spec §2.5): `mtimeScan` over every existing mirror vendor
 * root, with the project-key cache cleared first. Runs at daemon startup,
 * every `RECALL_HUB_SWEEP_MS` (default 300000) and on `SIGUSR1`.
 *
 * @module hub/sweep
 */

import { remoteRoot, transcriptGlob } from '../paths.js';
import { mtimeScan, sessionIdFromPath, type ScanResult } from '../recall/mtime-scan.js';
import { clearProjectKeyCache } from '../recall/project-key.js';
import { classifySession } from '../recall/session-classifier.js';
import { findCollision } from './ingest-queue.js';
import { mirrorRoots } from './mirror.js';
import { hubLog } from './runtime.js';

export const DEFAULT_SWEEP_MS = 300_000;

export function sweepIntervalMs(): number {
  const raw = process.env['RECALL_HUB_SWEEP_MS'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SWEEP_MS;
}

/** Host segment of a mirror path: `<remoteRoot()>/<host>/<vendor>/…`. */
export function hostOfMirrorPath(file: string): string | null {
  const prefix = transcriptGlob(remoteRoot()) + '/';
  const norm = file.replace(/\\/g, '/');
  if (!norm.startsWith(prefix)) return null;
  const host = norm.slice(prefix.length).split('/')[0];
  return host && host.length > 0 ? host : null;
}

const loggedRefusals = new Set<string>();

/**
 * The push-path collision check (S11) applied to the sweep: a refused push
 * leaves its bytes on disk with no watermark, so without this guard the next
 * sweep would merge the other machine's session through `INSERT OR IGNORE`
 * and overwrite its provenance. Also applied by the backfill/repair catch-up
 * for mirror files. Logged once per path per process.
 */
export function mirrorSweepGuard(file: string, vendor: 'claude' | 'codex'): string | null {
  const host = hostOfMirrorPath(file);
  if (!host) return null;
  const sessionId = sessionIdFromPath(file, vendor);
  const c = classifySession({ sessionId, transcriptPath: file, vendor });
  if (c.unresolvable) return null; // the ingest itself skips it
  const existing = findCollision(c.canonicalSessionId, host);
  if (existing === null) return null;
  if (!loggedRefusals.has(file)) {
    loggedRefusals.add(file);
    hubLog(`session-id collision host=${host} sid=${c.canonicalSessionId} existing=${existing} source=scan`);
  }
  return `session-id collision with ${existing}`;
}

export async function runMirrorSweep(): Promise<ScanResult> {
  clearProjectKeyCache();
  return mtimeScan({ roots: mirrorRoots(), guard: mirrorSweepGuard });
}
