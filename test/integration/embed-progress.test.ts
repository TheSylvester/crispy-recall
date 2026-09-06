/** Real detached bundle: content poison and unavailable backend both terminate. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, openSync, closeSync, ftruncateSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

let home: string, restore: () => void;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recall-embed-progress-')); restore = _setTestRoot(home); _resetDb();
  for (const sub of ['bin', 'models', 'claude/projects/test', 'codex/sessions']) mkdirSync(join(home, sub), { recursive: true });
  const fd = openSync(join(home, 'models/nomic-embed-text-v1.5.Q8_0.gguf'), 'w'); ftruncateSync(fd, 101_000_000); closeSync(fd);
});
afterEach(() => { _resetDb(); restore(); rmSync(home, { recursive: true, force: true }); });
function run(fail: boolean, sessionId?: string) {
  for (const name of ['llama-embedding', 'llama-server']) {
    const path = join(home, 'bin', name);
    writeFileSync(path, `#!${process.execPath}\nconst fs=require('node:fs');\n${fail ? 'process.exit(1);' : ''}\nconst a=process.argv;let p=a[a.indexOf('-p')+1];if(a.includes('-f'))p=fs.readFileSync(a[a.indexOf('-f')+1],'utf8');\nprocess.stdout.write(JSON.stringify(p.split('<#sep#>').map(()=>Array.from({length:768},(_,i)=>i===0?1:0))));\n`);
    chmodSync(path, 0o755);
  }
  _resetDb();
  return spawnSync(process.execPath, [join(__dirname, '../../dist/embed-pending.js'), ...(sessionId ? [sessionId] : [])], {
    env: { ...process.env, RECALL_HOME: home, RECALL_REMOTE_ROOT: join(home, 'remote'), CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') }, encoding: 'utf8', timeout: 10_000,
  });
}
function seed(text: string) {
  getDb(dbPath()).run('INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at) VALUES (?, ?, 0, ?, 1)', ['seed', 'seed-session', text]);
}
describe.skipIf(process.platform === 'win32')('embed-pending progress', () => {
  it('bounds zero-success retries, reaches T2 scan, exits and releases its lock', () => {
    seed('unavailable backend '.repeat(5));
    writeFileSync(join(home, 'claude/projects/test/missed.jsonl'), JSON.stringify({ type: 'user', uuid: 'missed', message: { role: 'user', content: 'hello' } }) + '\n');
    const result = run(true);
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(home, 'run/embed.lock'))).toBe(false);
    expect(getDb(dbPath()).get("SELECT message_id FROM messages WHERE message_id='missed'")).toBeTruthy();
    expect(JSON.parse(readFileSync(join(home, 'logs/embed-failure.json'), 'utf8')).attempts).toBe(3);
    const nextStop = run(false, 'seed-session');
    expect(nextStop.status, nextStop.stderr).toBe(0);
    expect(getDb(dbPath()).get("SELECT message_id FROM message_vectors WHERE message_id='seed'")).toBeUndefined();
    _resetDb();
    const attended = spawnSync(process.execPath, [join(__dirname, '../../dist/recall.js'), 'backfill', '--auto-embed'], {
      env: { ...process.env, RECALL_HOME: home, RECALL_REMOTE_ROOT: join(home, 'remote'), CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') }, encoding: 'utf8', timeout: 10_000,
    });
    expect(attended.error).toBeUndefined(); expect(attended.status, attended.stderr).toBe(0);
    expect(getDb(dbPath()).get("SELECT message_id FROM message_vectors WHERE message_id='seed'")).toBeTruthy();
  });
  it('embeds legacy NUL text through real argv transport and exits', () => {
    seed('\0' + 'legacy text '.repeat(6) + '\0poison');
    const result = run(false);
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(getDb(dbPath()).get("SELECT message_id FROM message_vectors WHERE message_id='seed'")).toBeTruthy();
    expect(existsSync(join(home, 'run/embed.lock'))).toBe(false);
  });
});
