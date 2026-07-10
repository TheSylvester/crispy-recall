/**
 * §8.4 Opaque, round-trippable ID reads — BUILT-BUNDLE tests.
 *
 * Every case spawns the built dist/recall.js against an isolated RECALL_HOME
 * seeded with sessions/messages whose IDs exercise the opaque-ID surface:
 * UUIDs, agent-<hex> leaves, codex-jsonl-* message ids, literal `%`/`_`/
 * hyphen/uppercase, and descriptive agent IDs. A fake llama-embedding binary
 * is staged so any accidental embed attempt is (a) recorded and (b) never a
 * network download; read paths must never touch it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
  truncateSync, openSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { _setTestRoot, dbPath, binDir, modelsDir } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import { insertMessages } from '../../src/recall/message-store.js';

const ROOT = join(__dirname, '..', '..');
const CLI_BUNDLE = join(ROOT, 'dist', 'recall.js');

const UUID_SESSION = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';
const UUID_SESSION_2 = '2b7e1516-28ae-d2a6-abf7-158809cf4f3c';
const AGENT_SESSION = 'agent-a1b2c3d4';
const AGENT_SESSION_2 = 'agent-a1b99999';
const WEIRD_SESSION = '77777777-aaaa-bbbb-cccc-dddddddddddd';

let recallHome: string;
let logDir: string;
let restoreRoot: (() => void) | undefined;

interface RunResult { status: number | null; stdout: string; stderr: string }

function runCli(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [CLI_BUNDLE, ...args, '--no-catchup'], {
    env: {
      ...process.env,
      RECALL_HOME: recallHome,
      CLAUDE_CONFIG_DIR: join(recallHome, 'claude-empty'),
      CODEX_HOME: join(recallHome, 'codex-empty'),
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function embedInvocations(): number {
  const p = join(logDir, 'invocations.jsonl');
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length;
}

/** Minimal fake llama-embedding: records the invocation, emits vectors. */
function stageFakeBackend(): void {
  mkdirSync(binDir(), { recursive: true });
  mkdirSync(modelsDir(), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const embedBin = join(binDir(), 'llama-embedding');
  writeFileSync(embedBin, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
fs.appendFileSync(path.join(${JSON.stringify(logDir)}, 'invocations.jsonl'), JSON.stringify({pid: process.pid}) + '\\n');
const args = process.argv.slice(2);
function argOf(f){const i=args.indexOf(f);return i>=0?args[i+1]:undefined;}
const sep = argOf('--embd-separator') || '<#sep#>';
let joined = argOf('-p'); if (joined === undefined) { const f = argOf('-f'); joined = f ? fs.readFileSync(f,'utf8') : ''; }
const texts = joined.split(sep);
process.stdout.write(JSON.stringify(texts.map(() => Array.from({length:768},(_,i)=>(i%7)/7-0.5))));
`);
  chmodSync(embedBin, 0o755);
  const serverBin = join(binDir(), 'llama-server');
  writeFileSync(serverBin, '#!/usr/bin/env node\nprocess.exit(1);\n');
  chmodSync(serverBin, 0o755);
  const model = join(modelsDir(), 'nomic-embed-text-v1.5.Q8_0.gguf');
  const fd = openSync(model, 'w');
  closeSync(fd);
  truncateSync(model, 150_000_000);
}

function seed(): void {
  getDb(dbPath());
  const now = Date.now();
  const mk = (sid: string, mid: string, seq: number, text: string) => ({
    message_id: mid, session_id: sid, message_seq: seq, message_text: text,
    project_id: null, created_at: now - (1000 - seq) * 1000, message_role: seq % 2 === 0 ? 'user' : 'assistant',
  });
  insertMessages([
    // UUID session with UUID-style and codex-jsonl-* message ids.
    mk(UUID_SESSION, 'aaaaaaaa-1111-2222-3333-444444444444', 0, 'please refactor the flux capacitor module'),
    mk(UUID_SESSION, `codex-jsonl-${UUID_SESSION.slice(0, 8)}-1`, 1, 'refactored the flux capacitor into three files'),
    mk(UUID_SESSION, `codex-jsonl-${UUID_SESSION.slice(0, 8)}-2`, 2, 'now run the flux tests'),
    // Second UUID session (distinct prefix).
    mk(UUID_SESSION_2, 'bbbbbbbb-1111-2222-3333-444444444444', 0, 'investigate the tachyon regression suite'),
    // Two agent sessions sharing the prefix agent-a1b → ambiguity case.
    mk(AGENT_SESSION, 'agent-msg-0001', 0, 'subagent leaf exploring the flux capacitor internals'),
    mk(AGENT_SESSION, 'agent-msg-0002', 1, 'subagent leaf final answer about capacitor internals'),
    mk(AGENT_SESSION_2, 'agent-msg-0003', 0, 'another leaf with a shared id prefix'),
    // Literal-character session: %, _, hyphen, uppercase, descriptive ids.
    // hasXunderscore-1 is a LIKE-wildcard trap: under LIKE, pattern
    // "has_underscore-1" (or prefix "has_u%") would ALSO match it.
    mk(WEIRD_SESSION, 'has%percent-1', 0, 'message with a percent id'),
    mk(WEIRD_SESSION, 'has_underscore-1', 1, 'message with an underscore id'),
    mk(WEIRD_SESSION, 'hasXunderscore-1', 2, 'like-wildcard trap message'),
    mk(WEIRD_SESSION, 'Upper-Case-ID-1', 3, 'message with an uppercase id'),
    mk(WEIRD_SESSION, 'descriptive-agent-task-result', 4, 'descriptive identifier message'),
  ]);
  _resetDb();
}

beforeAll(() => {
  if (!existsSync(CLI_BUNDLE)) throw new Error('dist/recall.js missing — run `npm run build` first');
  recallHome = join(tmpdir(), `recall-opaque-${randomUUID()}`);
  logDir = join(recallHome, 'fake-log');
  mkdirSync(join(recallHome, 'claude-empty'), { recursive: true });
  mkdirSync(join(recallHome, 'codex-empty'), { recursive: true });
  restoreRoot = _setTestRoot(recallHome);
  stageFakeBackend();
  seed();
});

afterAll(() => {
  restoreRoot?.();
  _resetDb();
  rmSync(recallHome, { recursive: true, force: true });
});

describe.skipIf(platform() === 'win32')('CLI opaque reads (built bundle)', () => {
  it('reads a UUID session by exact ID and by unique prefix', () => {
    for (const ref of [UUID_SESSION, UUID_SESSION.slice(0, 8), UUID_SESSION.slice(0, 12)]) {
      const r = runCli([ref]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Session: ${UUID_SESSION}`);
    }
  }, 60_000);

  it('reads an agent-* session by exact ID and by unique literal prefix', () => {
    for (const ref of [AGENT_SESSION, 'agent-a1b2']) {
      const r = runCli([ref]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Session: ${AGENT_SESSION}`);
    }
  }, 60_000);

  it('centers a read on a codex-jsonl-* message id inside a UUID session', () => {
    const mid = `codex-jsonl-${UUID_SESSION.slice(0, 8)}-1`;
    const r = runCli([UUID_SESSION.slice(0, 8), mid]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('>>>');
    expect(r.stdout).toContain('refactored the flux capacitor');
    // Prefix form of the opaque message id also resolves (unique in-session).
    const r2 = runCli([UUID_SESSION, 'codex-jsonl-019c3ae2-1']);
    expect(r2.status, r2.stderr).toBe(0);
  }, 60_000);

  it('resolves literal %, _, hyphen, uppercase, and descriptive message ids (no LIKE wildcards)', () => {
    for (const [ref, expectText] of [
      ['has%percent-1', 'percent id'],
      ['has_underscore-1', 'underscore id'],
      ['Upper-Case-ID-1', 'uppercase id'],
      ['descriptive-agent-task-result', 'descriptive identifier'],
    ] as const) {
      const r = runCli(['read', WEIRD_SESSION, ref]);
      expect(r.status, `${ref}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(expectText);
    }
    // Literal-prefix trap: under LIKE, "has_u" would match hasXunderscore-1
    // too (ambiguous). substr semantics resolve uniquely.
    const r = runCli(['read', WEIRD_SESSION, 'has_u']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('underscore id');
  }, 60_000);

  it('ambiguous session prefix exits nonzero and prints FULL candidate IDs', () => {
    const r = runCli(['agent-a1b']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(AGENT_SESSION);
    expect(r.stderr).toContain(AGENT_SESSION_2);
  }, 60_000);

  it('nonexistent session-shaped reference exits nonzero, names the search escape, and never embeds', () => {
    const before = embedInvocations();
    const r = runCli(['deadbeef']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No session found/);
    expect(r.stderr).toMatch(/recall search/);
    expect(embedInvocations()).toBe(before); // never fell through to semantic search
  }, 60_000);

  it('three-plus positionals in a read shape error instead of truncating to two', () => {
    const r = runCli([UUID_SESSION.slice(0, 8), 'foo', 'bar']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/recall search/);
    expect(r.stderr).toMatch(/recall read/);
  }, 60_000);

  it('explicit read validates arity too', () => {
    const r = runCli(['read', UUID_SESSION, 'x', 'y']);
    expect(r.status).toBe(1);
    const r2 = runCli(['read']);
    expect(r2.status).toBe(1);
  }, 60_000);

  it('multiword searches still search: agent-based retrieval is not captured as a read', () => {
    const r = runCli(['agent-based', 'retrieval', '--raw', '--all']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.query).toBe('agent-based retrieval');
  }, 60_000);

  it('a quoted multiword phrase (one positional with spaces) reaches search', () => {
    const r = runCli(['flux capacitor module', '--raw', '--all']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.query).toBe('flux capacitor module');
    expect(parsed.sessions.length).toBeGreaterThan(0);
  }, 60_000);

  it('the documented force-search escape works for ID-shaped terms', () => {
    const r = runCli(['search', 'agent-a1b2c3d4', '--raw', '--all']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.query).toBe('agent-a1b2c3d4');
  }, 60_000);

  it('every displayed search reference round-trips to the exact message', () => {
    const raw = runCli(['flux capacitor', '--raw', '--all']);
    expect(raw.status, raw.stderr).toBe(0);
    const parsed = JSON.parse(raw.stdout) as {
      sessions: Array<{ session_id: string; best_message_id: string }>;
    };
    expect(parsed.sessions.length).toBeGreaterThan(0);
    for (const s of parsed.sessions) {
      const r = runCli([s.session_id, s.best_message_id]);
      expect(r.status, `${s.session_id} ${s.best_message_id}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`Session: ${s.session_id}`);
      expect(r.stdout).toContain('>>>');
    }
  }, 120_000);

  it('the human search table shows full IDs that round-trip', () => {
    const r = runCli(['tachyon regression', '--all']);
    expect(r.status, r.stderr).toBe(0);
    const dataLine = r.stdout.split('\n').find((l) => l.includes(UUID_SESSION_2));
    expect(dataLine, `table should contain the full session id:\n${r.stdout}`).toBeTruthy();
    const tokens = dataLine!.trim().split(/\s+/);
    // rank, session, message, …
    const sid = tokens[1]!;
    const mid = tokens[2]!;
    const read = runCli([sid, mid]);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toContain(`Session: ${UUID_SESSION_2}`);
  }, 60_000);

  it('the --list table shows full session IDs that round-trip', () => {
    const r = runCli(['--list', '--all']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(UUID_SESSION); // full, untruncated
    const read = runCli([UUID_SESSION]);
    expect(read.status).toBe(0);
  }, 60_000);

  it('valid and invalid explicit read paths never start llama-embedding', () => {
    const before = embedInvocations();
    expect(runCli(['read', UUID_SESSION]).status).toBe(0);
    expect(runCli(['read', 'no-such-session-anywhere']).status).toBe(1);
    expect(runCli([UUID_SESSION, `codex-jsonl-${UUID_SESSION.slice(0, 8)}-2`]).status).toBe(0);
    expect(runCli([UUID_SESSION, 'nonexistent-message-ref']).status).toBe(1);
    expect(embedInvocations()).toBe(before);
  }, 120_000);

  it('raw JSON read output preserves full IDs', () => {
    const r = runCli([UUID_SESSION, `codex-jsonl-${UUID_SESSION.slice(0, 8)}-1`, '--raw']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.session_id).toBe(UUID_SESSION);
    expect(parsed.target_message_id).toBe(`codex-jsonl-${UUID_SESSION.slice(0, 8)}-1`);
  }, 60_000);
});
