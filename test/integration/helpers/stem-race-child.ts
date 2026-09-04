/**
 * Child for the `_stem` two-process race test. Bundled at test time with
 * esbuild; reads a JSON word list, stems each word through the real
 * `fts5Stem` (per-connection temp scratch tables), writes the JSON result.
 * Env (RECALL_HOME etc.) is passed explicitly by the parent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getDb } from '../../../src/db.js';
import { dbPath } from '../../../src/paths.js';
import { fts5Stem } from '../../../src/recall/query-sanitizer.js';

const [wordsFile, outFile, passesRaw] = process.argv.slice(2);
const words = JSON.parse(readFileSync(wordsFile!, 'utf8')) as string[];
const passes = Number(passesRaw ?? '1');
getDb(dbPath());
const out: string[][] = [];
for (let p = 0; p < passes; p++) out.push(words.map((w) => fts5Stem(w)));
writeFileSync(outFile!, JSON.stringify(out));
