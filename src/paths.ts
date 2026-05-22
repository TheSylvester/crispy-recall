/**
 * Paths — single source of truth for ~/.recall persistence paths.
 *
 * Pure resolution: no I/O beyond a single mkdir helper. `os.homedir()`
 * picks the right base on Linux, macOS, WSL, and Windows-native; `path.join`
 * handles separator differences. No `process.platform` branching needed.
 *
 * @module paths
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Test override
// ============================================================================

let rootOverride: string | null = null;

/** Override the recall root directory for testing. Returns a cleanup function. */
export function _setTestRoot(dir: string): () => void {
  const prev = rootOverride;
  rootOverride = dir;
  return () => { rootOverride = prev; };
}

// ============================================================================
// Path functions
// ============================================================================

/** Root persistence directory: ~/.recall/ on every platform.
 *  Honors the RECALL_HOME env var so cross-process bundles (Stop hook,
 *  embed-pending child) can be redirected to a test root. */
export function recallRoot(): string {
  if (rootOverride) return rootOverride;
  const envRoot = process.env['RECALL_HOME'];
  if (envRoot && envRoot.length > 0) return envRoot;
  return join(homedir(), '.recall');
}

/** Path to the SQLite database. */
export function dbPath(): string {
  return join(recallRoot(), 'recall.db');
}

/** Directory for downloaded embedding models. */
export function modelsDir(): string {
  return join(recallRoot(), 'models');
}

/** Directory for downloaded binaries (llama-embedding, llama-server). */
export function binDir(): string {
  return join(recallRoot(), 'bin');
}

/** Runtime directory for server sockets and PID files. */
export function runDir(): string {
  return join(recallRoot(), 'run');
}

/** Log directory. */
export function logsDir(): string {
  return join(recallRoot(), 'logs');
}

/** Ensure the recall root directory exists. Idempotent. */
export function ensureDir(): void {
  mkdirSync(recallRoot(), { recursive: true });
}
