#!/usr/bin/env node
/**
 * Force recall's embedder onto CPU by writing ~/.recall/config.json.
 *
 * config.json is the single source of truth for the GPU-vs-CPU decision (there
 * is NO env override — src/installer/config.ts). The shape below is exactly
 * EmbedderConfig; `readEmbedderConfig()` treats anything other than
 * mode:"gpu" as CPU (no `-ngl` offload). Used as the Metal-flake fallback: if
 * semantic search comes back UNAVAILABLE on the first pass, we drop to CPU and
 * re-embed rather than fighting the paravirtual Metal device.
 *
 * Merges over any existing config so unrelated keys survive (mirrors
 * writeEmbedderConfig).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const root = process.env.RECALL_HOME && process.env.RECALL_HOME.length > 0
  ? process.env.RECALL_HOME
  : join(homedir(), '.recall');
const p = join(root, 'config.json');

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(p, 'utf-8'));
} catch {
  // absent / unparseable — treat as empty, CPU is the safe default anyway
}
cfg.embedder = { mode: 'cpu', ngl: 0, libDir: null, detectedAt: '' };

mkdirSync(dirname(p), { recursive: true });
writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log(`forced embedder.mode=cpu at ${p}`);
