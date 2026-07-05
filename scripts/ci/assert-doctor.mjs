#!/usr/bin/env node
/**
 * Assert `recall doctor --json` reports a healthy native SQLite binding.
 *
 * doctor --json prints `{ ...report, embedder, binding }` (src/installer/doctor.ts).
 * We assert the five `binding.*` fields that together prove a real user's install
 * loads SQLite under native WAL with a valid ABI marker:
 *
 *   bindingLoads  === true      better_sqlite3.node dlopens under this Node
 *   journalMode   === "wal"     live DB is WAL, not delete-mode drift
 *   pinnedNodeOk  === true       marker's pinned Node path still exists
 *   abiOk         === true       staged ABI matches the running Node
 *   markerPresent === true       .binding-info.json was written
 *
 * Usage: node assert-doctor.mjs <doctor.json>
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('assert-doctor: pass the doctor --json output file');
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf-8'));
} catch (e) {
  console.error(`assert-doctor: ${file} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const b = doc.binding || {};
const want = {
  bindingLoads: true,
  journalMode: 'wal',
  pinnedNodeOk: true,
  abiOk: true,
  markerPresent: true,
};

const fails = Object.entries(want).filter(([k, v]) => b[k] !== v);
if (fails.length) {
  console.error('DOCTOR ASSERT FAIL — binding health mismatch:');
  for (const [k, v] of fails) console.error(`  ${k}: got ${JSON.stringify(b[k])}, want ${JSON.stringify(v)}`);
  console.error('full binding block:', JSON.stringify(b, null, 2));
  if (Array.isArray(b.problems) && b.problems.length) {
    console.error('doctor problems:');
    for (const p of b.problems) console.error(`  ✖ ${p}`);
  }
  process.exit(1);
}

console.log(`doctor OK — bindingLoads=true journalMode=wal pinnedNodeOk=true abiOk=true markerPresent=true (embedder=${doc.embedder?.mode ?? 'n/a'})`);
