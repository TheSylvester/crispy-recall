/**
 * embed-pending lockfile concurrency test.
 *
 * Spawns five embed-pending children in parallel against a shared temp DB and
 * asserts:
 *   - At most ONE child started a llama-server (the lock-holder).
 *   - All seeded messages end up in `message_vectors` exactly once.
 *   - The lockfile is unlinked after the active child exits.
 *   - A stale lock (dead PID, mtime > 30 min) is correctly taken over.
 *
 * Uses RECALL_HOME=/tmp/recall-test-* with the bin/ + models/ directories
 * symlinked to the real ~/.recall to skip a 5-minute binary/model download.
 * The DB and run/ directory are fresh per test run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Database as DatabaseConstructor } from 'node-sqlite3-wasm';

const ROOT = join(__dirname, '..', '..');
const EMBED_BUNDLE = join(ROOT, 'dist', 'embed-pending.js');
const REAL_RECALL_HOME = join(homedir(), '.recall');
const LLAMA_EMBED_BIN = join(REAL_RECALL_HOME, 'bin', 'llama-embedding');
const NOMIC_MODEL = join(REAL_RECALL_HOME, 'models', 'nomic-embed-text-v1.5.Q8_0.gguf');

const binariesReady =
  existsSync(EMBED_BUNDLE) && existsSync(LLAMA_EMBED_BIN) && existsSync(NOMIC_MODEL);

function seedMessages(dbFile: string, sessions: string[], perSession: number): string[] {
  const db = new DatabaseConstructor(dbFile);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id    TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      message_seq   INTEGER NOT NULL,
      message_text  TEXT NOT NULL,
      project_id    TEXT,
      created_at    INTEGER NOT NULL,
      message_role  TEXT,
      UNIQUE(session_id, message_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_text, content=messages, content_rowid=rowid, tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
    END;
    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id   TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
      embedding_q8 BLOB NOT NULL,
      norm         REAL NOT NULL,
      quant_scale  REAL NOT NULL
    );
  `);
  const ids: string[] = [];
  const insert = db.prepare(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    for (const sid of sessions) {
      for (let i = 0; i < perSession; i++) {
        const id = `${sid}-m${i}`;
        const role = i % 2 === 0 ? 'user' : 'assistant';
        // At least MIN_EMBED_CHARS (50) so the row isn't skipped.
        const text = `lockfile-test session ${sid} message ${i} role ${role} payload ${randomUUID()}`;
        insert.run([id, sid, i, text, '/tmp/test', Date.UTC(2026, 0, 1, 0, 0, i), role]);
        ids.push(id);
      }
    }
  } finally {
    insert.finalize();
    db.close();
  }
  return ids;
}

interface RunResult {
  exitCode: number | null;
  stderr: string;
  durationMs: number;
}

function runEmbedPending(sessionId: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [EMBED_BUNDLE, sessionId], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      exitCode: code,
      stderr,
      durationMs: Date.now() - started,
    }));
  });
}

describe.skipIf(!binariesReady)('embed-pending lockfile concurrency', () => {
  let recallHome: string;

  beforeAll(() => {
    if (!existsSync(EMBED_BUNDLE)) {
      throw new Error(
        `embed-pending bundle not found at ${EMBED_BUNDLE}. Run \`npm run build\` first.`,
      );
    }
    recallHome = join(tmpdir(), `recall-test-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    mkdirSync(join(recallHome, 'run'), { recursive: true });
    mkdirSync(join(recallHome, 'logs'), { recursive: true });
    // Empty transcript roots — embed-pending's T2 mtimeScan would otherwise
    // glob the real ~/.claude/projects/ (thousands of files) and try to
    // ingest them into the test DB, hanging the run.
    mkdirSync(join(recallHome, 'fake-claude', 'projects'), { recursive: true });
    mkdirSync(join(recallHome, 'fake-codex', 'sessions'), { recursive: true });
    // Symlink bin + models from the real recall home so the child doesn't
    // try to download (5+ min). The test DB and run/ stay tmp-isolated.
    symlinkSync(join(REAL_RECALL_HOME, 'bin'), join(recallHome, 'bin'));
    symlinkSync(join(REAL_RECALL_HOME, 'models'), join(recallHome, 'models'));
  });

  afterAll(() => {
    if (recallHome && existsSync(recallHome)) {
      rmSync(recallHome, { recursive: true, force: true });
    }
  });

  it('serializes 5 concurrent children to one llama-server, vectorizes everything', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => `lock-sess-${i}-${randomUUID().slice(0, 6)}`);
    const perSession = 10;
    const dbFile = join(recallHome, 'recall.db');
    const seeded = seedMessages(dbFile, sessions, perSession);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RECALL_HOME: recallHome,
      RECALL_LOG_LEVEL: 'info', // we need "Starting llama-server" in stderr
      CLAUDE_CONFIG_DIR: join(recallHome, 'fake-claude'),
      CODEX_HOME: join(recallHome, 'fake-codex'),
    };

    const results = await Promise.all(sessions.map((sid) => runEmbedPending(sid, env)));

    for (const r of results) {
      expect(r.exitCode).toBe(0);
    }

    // At most one child started a llama-server. The other 4 should have hit
    // the lock and exited silently.
    const serverStarts = results.filter((r) =>
      /Starting llama-server/.test(r.stderr),
    ).length;
    expect(serverStarts).toBeLessThanOrEqual(1);

    // Every seeded message is vectorized exactly once.
    const db = new DatabaseConstructor(dbFile);
    try {
      const rows = db.all(
        `SELECT message_id, COUNT(*) AS n FROM message_vectors GROUP BY message_id`,
      ) as Array<{ message_id: string; n: number }>;
      const vectorIds = new Set(rows.map((r) => r.message_id));
      for (const id of seeded) {
        expect(vectorIds.has(id)).toBe(true);
      }
      for (const r of rows) {
        expect(r.n).toBe(1);
      }
    } finally {
      db.close();
    }

    // Lockfile cleaned up after the active child exited.
    expect(existsSync(join(recallHome, 'run', 'embed.lock'))).toBe(false);
  }, 180_000);

  it('takes over a stale lock (dead PID + old mtime)', async () => {
    const sessions = [`stale-sess-${randomUUID().slice(0, 6)}`];
    const perSession = 5;
    const dbFile = join(recallHome, 'recall.db');
    const seeded = seedMessages(dbFile, sessions, perSession);

    // Plant a stale lock: PID we know is dead + mtime > 30 min ago.
    const lockPath = join(recallHome, 'run', 'embed.lock');
    writeFileSync(lockPath, '99999');
    const oldTime = (Date.now() - 32 * 60 * 1000) / 1000;
    utimesSync(lockPath, oldTime, oldTime);
    expect(existsSync(lockPath)).toBe(true);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RECALL_HOME: recallHome,
      RECALL_LOG_LEVEL: 'info',
      CLAUDE_CONFIG_DIR: join(recallHome, 'fake-claude'),
      CODEX_HOME: join(recallHome, 'fake-codex'),
    };

    const result = await runEmbedPending(sessions[0], env);
    expect(result.exitCode).toBe(0);

    // It should have taken the lock and actually embedded.
    const db = new DatabaseConstructor(dbFile);
    try {
      const rows = db.all(
        `SELECT message_id FROM message_vectors WHERE message_id IN (${seeded.map(() => '?').join(',')})`,
        seeded,
      ) as Array<{ message_id: string }>;
      expect(rows.length).toBe(seeded.length);
    } finally {
      db.close();
    }

    // Lockfile released after exit.
    expect(existsSync(lockPath)).toBe(false);
  }, 180_000);
});
