#!/usr/bin/env node
/**
 * Assert on `recall "<query>" --raw --all` output.
 *
 * The --raw JSON (src/cli/recall.ts runSearch) carries total_messages, fts_count,
 * semantic_count and semantic_available. We split the two concerns:
 *
 *   default        → require at least one hit (total_messages >= 1). FTS alone
 *                    guarantees this for our distinctive tokens, so it is the
 *                    hard gate that must pass regardless of the embedder.
 *   --require-semantic → additionally require semantic_available === true, i.e.
 *                    the live query embed succeeded (Metal or CPU). semantic_count
 *                    may still be 0; availability (not doc-hit count) is the signal.
 *
 * Usage: node assert-search.mjs <search.json> [--require-semantic]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const requireSemantic = process.argv.includes('--require-semantic');
if (!file) {
  console.error('assert-search: pass the recall --raw output file');
  process.exit(2);
}

let d;
try {
  d = JSON.parse(readFileSync(file, 'utf-8'));
} catch (e) {
  console.error(`assert-search: ${file} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const errs = [];
if (!(Number(d.total_messages) >= 1)) errs.push(`expected >=1 hit, got total_messages=${d.total_messages}`);
if (requireSemantic && d.semantic_available !== true) {
  errs.push(`semantic_available=${d.semantic_available} (expected true)`);
}

if (errs.length) {
  console.error('SEARCH ASSERT FAIL:', errs.join('; '));
  console.error(`  query="${d.query}" total=${d.total_messages} fts=${d.fts_count} semantic=${d.semantic_count} semantic_available=${d.semantic_available}`);
  process.exit(1);
}

console.log(`search OK — query="${d.query}" total=${d.total_messages} fts=${d.fts_count} semantic=${d.semantic_count} semantic_available=${d.semantic_available}${requireSemantic ? ' [semantic required]' : ''}`);
