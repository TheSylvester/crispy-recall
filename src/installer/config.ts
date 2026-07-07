/**
 * Config — owns ~/.recall/config.json
 *
 * Single source of truth for the embedder backend decision (GPU vs CPU)
 * made at install time. embedder.ts reads this at runtime to decide whether
 * to pass `-ngl 999` and which directory to add to the dynamic-library
 * search path; the installer's GPU phase (gpu.ts) writes it.
 *
 * There is NO env-var override for the embedder mode — config.json is
 * authoritative. Repair is a CONSUMER of this file, never a producer.
 *
 * Owns: read/write/merge of ~/.recall/config.json.
 * Does not: detect GPUs, run offload tests (that is gpu.ts).
 *
 * @module installer/config
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recallRoot } from '../paths.js';
import { log } from '../log.js';
import { writeFileAtomic } from './settings-merge.js';

export interface EmbedderConfig {
  /** Resolved backend: 'gpu' = pass -ngl, 'cpu' = plain CPU embedding. */
  mode: 'gpu' | 'cpu';
  /** Number of layers to offload when mode === 'gpu'. */
  ngl: number;
  /** Absolute path to the staged GPU libs (libggml-cuda.so + cudart/cublas), or null. */
  libDir: string | null;
  /** ISO timestamp of the install-time GPU decision. */
  detectedAt: string;
  /** Free-text reason captured when the GPU path fell back to CPU (doctor surfaces this). */
  fallbackReason?: string;
}

export interface RecallConfig {
  /** Optional so a statusline-only merge type-checks. In practice the GPU phase
   *  always writes embedder before phase 7, so installs always carry it. */
  embedder?: EmbedderConfig;
  /** Opt-in statusLine feature record (present only when the user enabled it). */
  statusline?: {
    installed: boolean;
    /** Exact recall command written — ownership corroboration alongside isRecallStatusLine. */
    command: string;
    /** Prior statusLine to restore on uninstall. Always null in this design
     *  (recall only ever writes into an empty slot); kept for forward-compat. */
    priorStatusLine: { type?: string; command?: string } | null;
    installedAt: string; // ISO
  };
}

/** Absolute path to ~/.recall/config.json. */
export function configPath(): string {
  return join(recallRoot(), 'config.json');
}

/** Read the full config, or null if absent/unparseable. */
export function readConfig(): RecallConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as RecallConfig;
  } catch (err) {
    log({
      source: 'installer/config',
      level: 'warn',
      summary: `config.json unparseable (${(err as Error).message}) — treating as absent`,
    });
    return null;
  }
}

/**
 * Write the embedder decision, merging over any existing config so unrelated
 * future keys survive. Creates ~/.recall/ if missing.
 */
export function writeEmbedderConfig(embedder: EmbedderConfig): RecallConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const existing = readConfig() ?? {};
  const merged: RecallConfig = { ...existing, embedder };
  writeFileAtomic(p, JSON.stringify(merged, null, 2) + '\n');
  log({
    source: 'installer/config',
    level: 'info',
    summary: `config.json written (embedder.mode=${embedder.mode})`,
  });
  return merged;
}

/**
 * Write the statusline record, merging over any existing config so the embedder
 * decision survives. Creates ~/.recall/ if missing. Mirrors writeEmbedderConfig.
 */
export function writeStatuslineConfig(statusline: NonNullable<RecallConfig['statusline']>): RecallConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const existing = readConfig() ?? {};
  const merged: RecallConfig = { ...existing, statusline };
  writeFileAtomic(p, JSON.stringify(merged, null, 2) + '\n');
  log({
    source: 'installer/config',
    level: 'info',
    summary: `config.json written (statusline.installed=${statusline.installed})`,
  });
  return merged;
}

/**
 * Drop the statusline record (uninstall / `--no-statusline` / reconciling after
 * the user switched to their own statusline). No-op when there is none.
 */
export function clearStatuslineConfig(): void {
  const existing = readConfig();
  if (!existing?.statusline) return;
  const { statusline: _dropped, ...rest } = existing;
  writeFileAtomic(configPath(), JSON.stringify(rest, null, 2) + '\n');
  log({
    source: 'installer/config',
    level: 'info',
    summary: 'config.json statusline record cleared',
  });
}

/**
 * Runtime accessor for embedder.ts. Returns the persisted embedder config, or
 * a safe CPU default if no config exists yet (fresh install / pre-Day-5 DB).
 */
export function readEmbedderConfig(): EmbedderConfig {
  const cfg = readConfig();
  if (cfg?.embedder?.mode === 'gpu') return cfg.embedder;
  return { mode: 'cpu', ngl: 0, libDir: null, detectedAt: '' };
}
