/**
 * `_stem` two-process race (spec S14): two child processes hammer the real
 * `fts5Stem` with 1,000 distinct words each, concurrently, against ONE
 * database. Every returned stem must equal the single-process oracle —
 * 0/2,000 wrong. On the old SHARED persistent `_stem` table the cross-process
 * interleave produced 14/6,000 wrong stems; the per-connection `temp.`
 * scratch tables make interleaving impossible, which is what licenses
 * HUB_QUERY_CONCURRENCY = 4.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

import { _setTestRoot, dbPath, recallRoot, remoteRoot } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { fts5Stem } from '../../src/recall/query-sanitizer.js';
import { HUB_QUERY_CONCURRENCY } from '../../src/hub/query.js';

const win32 = platform() === 'win32';
const ROOT = join(__dirname, '..', '..');

let sandbox: string;
let restore: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

/** 2,000 distinct pronounceable words with real suffixes the porter stemmer rewrites. */
function words(): string[] {
  const syl = ['ba', 'ko', 'ri', 'tu', 'me', 'so', 'la', 'vi', 'no', 'pe'];
  const suffixes = ['ing', 'ations', 'ness', 'ized', 'fully', 'ational', 'iveness', 'alism', 'ently', 'ously'];
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const a = syl[i % 10]!, b = syl[Math.floor(i / 10) % 10]!, c = syl[Math.floor(i / 100) % 10]!;
    out.push(`${a}${b}${c}${suffixes[Math.floor(i / 1000) % 10]}${suffixes[(i * 7) % 10]}`);
  }
  return [...new Set(out)];
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-stem-race-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_REMOTE_ROOT']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = join(sandbox, 'claude');
  process.env['CODEX_HOME'] = join(sandbox, 'codex');
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, '.recall', 'remote');
  _resetDb();
});

afterAll(() => {
  restore?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(win32)('_stem two-process race', () => {
  it('sandbox guard', () => {
    expect(resolve(recallRoot()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(remoteRoot()).startsWith(resolve(tmpdir()))).toBe(true);
  });

  it('two concurrent processes return 0/2,000 wrong stems against the single-process oracle', async () => {
    const all = words();
    expect(all.length).toBe(2000);
    getDb(dbPath()); // create the sandbox DB
    _resetDb();

    const childJs = join(sandbox, 'stem-child.cjs');
    buildSync({
      entryPoints: [join(ROOT, 'test', 'integration', 'helpers', 'stem-race-child.ts')],
      outfile: childJs, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
    });
    const binding = join(ROOT, 'dist', 'better_sqlite3.node');
    expect(existsSync(binding)).toBe(true);
    copyFileSync(binding, join(sandbox, 'better_sqlite3.node'));

    const halves = [all.slice(0, 1000), all.slice(1000)];
    const runs = halves.map((half, i) => {
      const wf = join(sandbox, `words-${i}.json`);
      const of = join(sandbox, `out-${i}.json`);
      writeFileSync(wf, JSON.stringify(half));
      return new Promise<string[][]>((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [childJs, wf, of, '3'], {
          env: {
            ...process.env,
            RECALL_HOME: join(sandbox, '.recall'),
            RECALL_REMOTE_ROOT: join(sandbox, '.recall', 'remote'),
            CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
            CODEX_HOME: join(sandbox, 'codex'),
            RECALL_LOG_LEVEL: 'error',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (c) => { err += String(c); });
        child.on('close', (code) => {
          if (code !== 0) rejectRun(new Error(`child ${i} exited ${code}: ${err}`));
          else resolveRun(JSON.parse(readFileSync(of, 'utf-8')));
        });
      });
    });
    const results = await Promise.all(runs);

    // Oracle: one process, sequential.
    getDb(dbPath());
    const oracle = halves.map((half) => half.map((w) => fts5Stem(w)));
    let wrong = 0;
    let stemmedDiffers = 0;
    for (let i = 0; i < 2; i++) {
      for (const pass of results[i]!) {
        for (let j = 0; j < pass.length; j++) if (pass[j] !== oracle[i]![j]) wrong++;
      }
      for (let j = 0; j < halves[i]!.length; j++) if (oracle[i]![j] !== halves[i]![j]!.toLowerCase()) stemmedDiffers++;
    }
    expect(stemmedDiffers).toBeGreaterThan(1000); // the stemmer really did work (not the lowercase fallback)
    expect(wrong).toBe(0);
    expect(HUB_QUERY_CONCURRENCY).toBe(4);
  }, 60_000);
});
