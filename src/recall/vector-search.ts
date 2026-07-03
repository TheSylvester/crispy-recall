/**
 * Vector Search — Dual-path retrieval combining FTS5 keyword and semantic search
 *
 * Runs FTS5 BM25 keyword search and q8 semantic brute-force scan as
 * CO-EQUAL retrieval paths on every query. Results are merged via
 * Reciprocal Rank Fusion (RRF) — scale-invariant, boosts results found by
 * both paths. Recency weighting is off by default; `--recent` opts into
 * absolute age decay.
 *
 * Query pipeline:
 *   1. Embed query with Nomic (~50ms)
 *   2. Quantize query vector to q8
 *   3. Path A — BM25: FTS5 MATCH on messages_fts
 *   4. Path B — Semantic: full table scan of message_vectors, q8 dot product
 *   5. RRF merge — fuse ranked lists, deduplicate, take top-K
 *
 * Owns: search orchestration, result merging.
 * Does not: persist data, manage models.
 *
 * @module recall/vector-search
 */

import { embed } from './embedder.js';
import { quantizeToQ8, computeNorm } from './quantize.js';
import { searchMessagesFts, searchMessagesSemantic } from './message-store.js';
import type { MessageSearchResult } from './message-store.js';
import { QUERY_PREFIX } from './embed-config.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DualPathSearchOptions {
  limit?: number;
  projectId?: string;
  sessionId?: string;
  /** Session ID to exclude from results (caller's own session). */
  excludeSessionId?: string;
  /** Recency decay rate on the RRF score. `undefined`/`0` → off (recency 1 —
   *  the default; retrieval relevance is not re-weighted by age). `> 0` →
   *  absolute now-anchored `1/(1+ageDays·decay)`; `--recent` passes 0.10. */
  recencyDecay?: number;
  /** Bypass the IDF (high-frequency term) sanitizer on the FTS5 path. When set,
   *  common-but-meaningful terms ("when"/"before"/"after") survive instead of
   *  being dropped. Escaping is unchanged. Used by the `--no-idf` config. */
  skipIdf?: boolean;
}

export interface ScoredResult {
  result: MessageSearchResult;
  /** RRF score (higher = more relevant). Used by groupBySession for score-gap detection. */
  score: number;
  /** Which search paths found this result. */
  paths: ('fts5' | 'semantic')[];
}

export interface DualPathSearchResult {
  results: MessageSearchResult[];
  /** Scored results preserving RRF scores — used for session-level score gap detection. */
  scored: ScoredResult[];
  /** Whether the semantic (embedding) path was available and produced results. */
  semanticAvailable: boolean;
  /** Number of results from FTS5 keyword search. */
  ftsCount: number;
  /** Number of results from semantic vector search (0 if unavailable). */
  semanticCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 200; // generous ceiling — score gap cuts naturally within this
const FETCH_MULTIPLIER = 3; // fetch more from each path to improve union quality
const RRF_K = 60; // Reciprocal Rank Fusion constant — dampens top-rank dominance
const SEMANTIC_DISCOVERY_BOOST = 1.05; // gentle lift for sessions found only by semantic path

// ---------------------------------------------------------------------------
// Recency weighting
// ---------------------------------------------------------------------------

/**
 * Per-candidate recency multiplier on the RRF score. `decay` falsy/≤0 → 1 (off,
 * the default). `> 0` → absolute now-anchored `1/(1+ageDays·decay)`; `--recent` = 0.10.
 */
export function recencyMultiplier(decay: number | undefined, ageMs: number): number {
  if (!(decay && decay > 0)) return 1;
  const ageDays = Math.max(0, ageMs) / 86_400_000; // future-dated (clock skew) → age 0, no penalty
  return 1 / (1 + ageDays * decay);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dual-path search: runs FTS5 keyword search and semantic vector search,
 * unions results, and deduplicates by message_id.
 *
 * If the embedding model is unavailable, falls back to FTS5-only.
 * If message_vectors is empty, the semantic path returns nothing and
 * FTS5 results are used alone.
 */
export async function dualPathSearch(
  query: string,
  opts?: DualPathSearchOptions,
): Promise<DualPathSearchResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const fetchLimit = limit * FETCH_MULTIPLIER;

  if (!query.trim()) return { results: [], scored: [], semanticAvailable: false, ftsCount: 0, semanticCount: 0 };

  // Embed the query and quantize
  let queryQ8: Int8Array | null = null;
  let queryNorm = 0;
  let queryScale = 0;
  let semanticAvailable = true;

  try {
    const queryF32 = await embed(QUERY_PREFIX + query);
    queryNorm = computeNorm(queryF32);
    const quantized = quantizeToQ8(queryF32);
    queryQ8 = quantized.q8;
    queryScale = quantized.scale;
  } catch (err) {
    semanticAvailable = false;
    log({
      source: 'recall:dual-path',
      level: 'warn',
      summary: `Semantic path disabled — embed() failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Run both paths (both are synchronous SQLite operations)
  const ftsResults = searchMessagesFts(query, fetchLimit, opts?.projectId, opts?.sessionId, opts?.excludeSessionId, opts?.skipIdf);

  const semanticResults = queryQ8 && queryNorm > 0
    ? searchMessagesSemantic(queryQ8, queryNorm, queryScale, {
        limit: fetchLimit,
        projectId: opts?.projectId,
        sessionId: opts?.sessionId,
        excludeSessionId: opts?.excludeSessionId,
      })
    : [];

  // If embed succeeded but produced 0 semantic results, that's still "available"
  // (just no matches). Only mark unavailable if embed() itself failed.
  log({
    source: 'recall:dual-path',
    level: semanticAvailable ? 'info' : 'warn',
    summary: `FTS5: ${ftsResults.length} results, Semantic: ${semanticResults.length} results${!semanticAvailable ? ' (UNAVAILABLE — embed failed)' : ''}`,
  });

  // RRF merge with recency weighting — scale-invariant fusion of ranked lists
  const decay = opts?.recencyDecay;
  const now = Date.now();
  const rrfScores = new Map<string, ScoredResult>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i]!;
    const recency = recencyMultiplier(decay, now - r.created_at);
    rrfScores.set(r.message_id, { result: r, score: (1 / (RRF_K + i)) * recency, paths: ['fts5'] });
  }

  const ftsSessionIdSet = new Set(ftsResults.map(r => r.session_id));

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i]!;
    const recency = recencyMultiplier(decay, now - r.created_at);
    const rrfScore = (1 / (RRF_K + i)) * recency;
    const existing = rrfScores.get(r.message_id);
    if (existing) {
      existing.score += rrfScore;
      existing.paths.push('semantic');
    } else {
      rrfScores.set(r.message_id, { result: r, score: rrfScore, paths: ['semantic'] });
    }
  }

  // Boost semantic-only discoveries: sessions FTS didn't find at all
  for (const entry of rrfScores.values()) {
    if (!ftsSessionIdSet.has(entry.result.session_id)) {
      entry.score *= SEMANTIC_DISCOVERY_BOOST;
    }
  }

  const merged = [...rrfScores.values()];
  merged.sort((a, b) => b.score - a.score);

  return {
    results: merged.slice(0, limit).map(m => m.result),
    scored: merged,  // full list with RRF scores — groupBySession uses for gap detection
    semanticAvailable,
    ftsCount: ftsResults.length,
    semanticCount: semanticResults.length,
  };
}
