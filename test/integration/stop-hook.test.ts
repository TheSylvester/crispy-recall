/**
 * Stop hook concurrency stress test.
 *
 * Fires 10 stop-hook child processes in parallel against a shared temp DB
 * and asserts every session lands in the messages table within 2 seconds,
 * no SQLITE_BUSY errors escape, and every child exits 0.
 *
 * The hook bundle is run from disk (`dist/stop-hook.js`) so the test
 * exercises the same code path Claude Code triggers in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Database as DatabaseConstructor } from 'node-sqlite3-wasm';

const ROOT = join(__dirname, '..', '..');
const HOOK_BUNDLE = join(ROOT, 'dist', 'stop-hook.js');

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

  beforeAll(() => {
    if (!existsSync(HOOK_BUNDLE)) {
      throw new Error(
        `Hook bundle not found at ${HOOK_BUNDLE}. Run \`npm run build\` first.`,
      );
    }
    recallHome = join(tmpdir(), `recall-test-${randomUUID()}`);
    mkdirSync(join(recallHome, 'projects'), { recursive: true });
  });

  afterAll(() => {
    if (recallHome && existsSync(recallHome)) {
      rmSync(recallHome, { recursive: true, force: true });
    }
  });

  it('ingests 10 concurrent sessions with no SQLITE_BUSY escapes', async () => {
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

    const dbFile = join(recallHome, 'recall.db');
    const db = new DatabaseConstructor(dbFile);
    try {
      for (const p of payloads) {
        const rows = db.all(
          'SELECT message_id FROM messages WHERE session_id = ?',
          [p.session_id],
        ) as Array<Record<string, unknown>>;
        expect(rows.length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }

    expect(elapsed).toBeLessThan(2000);
  }, 30_000);
});
