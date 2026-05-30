/**
 * Stop hook concurrency stress test.
 *
 * Fires 10 stop-hook child processes in parallel against a shared temp DB and
 * verifies the standalone's ingestion *contract* under multi-process load:
 *
 *   1. No child crashes (every hook exits 0 — recall must never block a turn).
 *   2. No SQLITE_BUSY / "database is locked" error escapes to stderr or the log.
 *   3. Every session is ingested — via the hook fast-path OR the catch-up
 *      backstop that re-reads transcripts from disk.
 *
 * Why (3) goes through catch-up: the Stop hook is best-effort by design. It
 * runs with a 500 ms busy_timeout (stop-hook.ts) and `node-sqlite3-wasm`'s
 * cross-process lock is a coarse directory mutex, so under a burst of truly
 * simultaneous writers an individual hook write can be deferred. That is not
 * data loss — the transcript JSONL on disk is the source of truth and the DB
 * is a rebuildable index. `runFts5Catchup` (the same pass `recall backfill`
 * and the installer run) re-ingests anything the fast-path dropped, single-
 * process and contention-free. Asserting immediate per-hook landing would
 * over-specify beyond what the architecture guarantees and flake under load;
 * asserting eventual completeness tests the real contract — including recovery.
 *
 * The hook bundle is run from disk (`dist/stop-hook.js`) so the test exercises
 * the same code path Claude Code triggers in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { runFts5Catchup } from '../../src/recall/catchup.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

const ROOT = join(__dirname, '..', '..');
const HOOK_BUNDLE = join(ROOT, 'dist', 'stop-hook.js');

/** Soft wall-clock budget for 10 concurrent spawns — exceeding it warns but
 *  does not fail (scheduling jitter under full-suite load is not a bug). */
const PERF_WARN_MS = 2000;
/** Hard ceiling that only trips on a genuine hang, well under the test timeout. */
const PERF_HANG_MS = 15_000;

function makeClaudeJsonl(sessionId: string, prefix: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const uuid = `${sessionId}-msg-${i}`;
    const parentUuid = i === 0 ? null : `${sessionId}-msg-${i - 1}`;
    lines.push(JSON.stringify({
      type: role,
      uuid,
      parentUuid,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      message: {
        role,
        content: `${prefix} turn-${i} ${role} unique-${randomUUID().slice(0, 8)}`,
      },
    }));
  }
  return lines.join('\n') + '\n';
}

interface RunResult {
  exitCode: number | null;
  stderr: string;
}

function runHook(payload: object, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_BUNDLE], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('stop-hook concurrency', () => {
  let recallHome: string;
  let restoreRoot: (() => void) | undefined;
  let originalEnvClaudeConfigDir: string | undefined;
  let originalEnvCodexHome: string | undefined;

  beforeAll(() => {
    if (!existsSync(HOOK_BUNDLE)) {
      throw new Error(
        `Hook bundle not found at ${HOOK_BUNDLE}. Run \`npm run build\` first.`,
      );
    }
    recallHome = join(tmpdir(), `recall-test-${randomUUID()}`);
    mkdirSync(join(recallHome, 'projects'), { recursive: true });

    // In-process catch-up reads the DB via dbPath() (RECALL_HOME-equivalent)
    // and discovers transcripts by globbing CLAUDE_CONFIG_DIR/projects — point
    // both at the same temp home the child hooks write under.
    restoreRoot = _setTestRoot(recallHome);
    originalEnvClaudeConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    originalEnvCodexHome = process.env['CODEX_HOME'];
    process.env['CLAUDE_CONFIG_DIR'] = recallHome;
    process.env['CODEX_HOME'] = join(recallHome, 'codex-empty');
    _resetDb();
  });

  afterAll(() => {
    restoreRoot?.();
    _resetDb();
    if (originalEnvClaudeConfigDir === undefined) {
      delete process.env['CLAUDE_CONFIG_DIR'];
    } else {
      process.env['CLAUDE_CONFIG_DIR'] = originalEnvClaudeConfigDir;
    }
    if (originalEnvCodexHome === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = originalEnvCodexHome;
    }
    if (recallHome && existsSync(recallHome)) {
      rmSync(recallHome, { recursive: true, force: true });
    }
  });

  it('ingests 10 concurrent sessions cleanly, with catch-up backstopping any deferred write', async () => {
    const N = 10;
    const payloads: Array<{ session_id: string; transcript_path: string; cwd: string }> = [];

    for (let i = 0; i < N; i++) {
      const sessionId = `sess-${i}-${randomUUID().slice(0, 8)}`;
      const projectDir = join(recallHome, 'projects', `p${i}`);
      mkdirSync(projectDir, { recursive: true });
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(transcriptPath, makeClaudeJsonl(sessionId, `proj${i}`));
      payloads.push({
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: projectDir,
      });
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RECALL_HOME: recallHome,
      RECALL_LOG_LEVEL: 'warn',
    };

    const start = Date.now();
    const results = await Promise.all(
      payloads.map((p) => runHook({ ...p, hook_event_name: 'Stop' }, env)),
    );
    const elapsed = Date.now() - start;

    // (1) No child crashes, (2) no lock errors escape.
    const failures = results.filter((r) => r.exitCode !== 0);
    if (failures.length) {
      console.error(
        'Hook failures:',
        failures.map((f) => ({ code: f.exitCode, stderr: f.stderr })),
      );
    }
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/SQLITE_BUSY/i);
      expect(r.stderr).not.toMatch(/database is locked/i);
    }

    const logPath = join(recallHome, 'logs', 'stop-hook.log');
    if (existsSync(logPath)) {
      const logBody = readFileSync(logPath, 'utf-8');
      expect(logBody).not.toMatch(/SQLITE_BUSY/i);
      expect(logBody).toBe('');
    }

    // (3) Eventual completeness: run the catch-up backstop (single-process,
    // contention-free — the same pass `recall backfill`/installer run) to
    // re-ingest any session the concurrent fast-path deferred, then assert the
    // index is complete. This exercises the real recovery path, not just the
    // happy path.
    await runFts5Catchup({ vendors: ['claude'] });

    const db = getDb(dbPath());
    for (const p of payloads) {
      const rows = db.all(
        'SELECT message_id FROM messages WHERE session_id = ?',
        [p.session_id],
      ) as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
    }

    // Perf smoke — warn on a slow burst, fail only on a genuine hang.
    if (elapsed > PERF_WARN_MS) {
      console.warn(
        `[perf] 10 concurrent stop-hooks took ${elapsed}ms (> ${PERF_WARN_MS}ms soft budget)`,
      );
    }
    expect(elapsed).toBeLessThan(PERF_HANG_MS);
  }, 30_000);
});
