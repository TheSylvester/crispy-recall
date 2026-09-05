/**
 * The two transcript roots, resolved in ONE place (spec §2.1 hub guard).
 *
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured everywhere — a scan, the
 * Stop hook, the installer, the satellite pusher — EXCEPT on a hub whose
 * override points into a DrvFs tree (`/mnt/<x>/…`). That case is the live
 * 2026-09-05 defect: a Codex Desktop agent ran inside WSL with
 * `CODEX_HOME=/mnt/c/Users/…/.codex`, the catch-up scan ingested the Windows
 * rollouts as LOCAL sessions, and every later push of the same ids from the
 * Windows satellite was refused as a session-id collision. The tree belongs
 * to the satellite that pushes it, so the hub ignores the override.
 *
 * On a satellite `readHostRecords()` is empty, so the guard NEVER fires there
 * and the pusher keeps reading the override tree it is told to push.
 *
 * @module recall/transcript-roots
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readHostRecords } from '../hub/runtime.js';
import { log } from '../log.js';

/** `/mnt/c/…` — a Windows drive mounted by WSL's DrvFs. */
const DRVFS = /^\/mnt\/[a-zA-Z]\//;

/** One warning per variable per process. */
const warned = new Set<string>();

export function defaultClaudeRoot(): string {
  return join(homedir(), '.claude');
}

export function defaultCodexRoot(): string {
  return join(homedir(), '.codex');
}

/**
 * Do we ignore this override? Only on Linux, only for a DrvFs path, and only
 * when this installation is a hub with at least one registered host. An
 * unreadable host record reads as `{}` — a plain install is never guarded.
 */
function guardedHosts(override: string): string[] {
  if (process.platform !== 'linux') return [];
  const abs = resolve(override).replace(/\\/g, '/');
  if (!DRVFS.test(abs.endsWith('/') ? abs : `${abs}/`)) return [];
  return Object.keys(readHostRecords());
}

function resolveRoot(envVar: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME', fallback: string): string {
  const override = process.env[envVar];
  if (!override || override.length === 0) return fallback;
  const hosts = guardedHosts(override);
  if (hosts.length === 0) return override;
  if (!warned.has(envVar)) {
    warned.add(envVar);
    log({
      level: 'warn',
      source: 'transcript-roots',
      summary: `ignoring ${envVar}=${override}: this hub serves satellite ${hosts.join(', ')} `
        + 'and that tree is pushed by a satellite; set the variable elsewhere or unset it',
    });
  }
  return fallback;
}

/** `~/.claude`, or `$CLAUDE_CONFIG_DIR` when the hub guard does not apply. */
export function claudeRoot(): string {
  return resolveRoot('CLAUDE_CONFIG_DIR', defaultClaudeRoot());
}

/** `~/.codex`, or `$CODEX_HOME` when the hub guard does not apply. */
export function codexRoot(): string {
  return resolveRoot('CODEX_HOME', defaultCodexRoot());
}

export interface TranscriptRoot { vendor: 'claude' | 'codex'; root: string }

/** Both roots, in the vendor order every caller uses. */
export function transcriptRoots(): TranscriptRoot[] {
  return [
    { vendor: 'claude', root: claudeRoot() },
    { vendor: 'codex', root: codexRoot() },
  ];
}

/** Test seam — forget the once-per-process warning. */
export function _resetRootWarnings(): void {
  warned.clear();
}
