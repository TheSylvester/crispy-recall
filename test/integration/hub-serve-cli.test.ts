/**
 * `recall hub serve` startup gates (spec §2.1, §2.2): preflight, the bind
 * rule (ANY refused with `::`, an absent key, and the flag without tokens;
 * non-loopback without tokens), the codex re-key gate, `--port 0` publishing
 * the resolved port in hub.json, and the persisted config.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

import { CODEX_REKEY_MIGRATION_KEY } from '../../src/db.js';
import { cli, createDb, issueToken, makeSandbox, readHubJson, stagePlaceholders, startDaemon, type Sandbox } from './helpers/hub-harness.js';

const win32 = platform() === 'win32';

describe.skipIf(win32)('recall hub serve — startup gates', () => {
  let sb: Sandbox;

  beforeAll(() => {
    sb = makeSandbox('recall-hub-serve-');
    expect(resolve(sb.recallHome).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(sb.remote).startsWith(resolve(tmpdir()))).toBe(true);
  });

  afterAll(() => { sb?.cleanup(); });

  it('refuses to start without the binary/model/DB, naming recall install and recall doctor', () => {
    const r = cli(sb, ['hub', 'serve', '--bind', '127.0.0.1', '--port', '0']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('recall install');
    expect(r.stderr).toContain('recall doctor');
  });

  it('refuses an ANY bind (::) without the flag, naming both remedies', () => {
    stagePlaceholders(sb.recallHome);
    createDb(sb);
    const r = cli(sb, ['hub', 'serve', '--bind', '::', '--port', '0']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--i-know-this-is-public');
    expect(r.stderr).toContain('recall hub token');
    expect(readHubJson(sb)).toBeNull();
  });

  it('refuses an absent bind key in config.json (ANY)', () => {
    const cfg = join(sb.recallHome, 'config.json');
    writeFileSync(cfg, JSON.stringify({ hub: { port: 0, installedAt: 'x' } }));
    const r = cli(sb, ['hub', 'serve']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--i-know-this-is-public');
    unlinkSync(cfg);
  });

  it('refuses ANY with the flag but no tokens, and a non-loopback bind without tokens', () => {
    const tokens = join(sb.recallHome, 'hub-tokens.json');
    if (existsSync(tokens)) unlinkSync(tokens);
    const any = cli(sb, ['hub', 'serve', '--bind', '0.0.0.0', '--port', '0', '--i-know-this-is-public']);
    expect(any.status).toBe(1);
    expect(any.stderr).toContain('recall hub token');
    const other = cli(sb, ['hub', 'serve', '--bind', '10.255.255.1', '--port', '0']);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('recall hub token');
    expect(readHubJson(sb)).toBeNull();
  });

  it('persists --bind/--port to config.json before binding, never a resolved --port 0', async () => {
    const d = await startDaemon(sb, { args: [] });
    try {
      const cfg = JSON.parse(readFileSync(join(sb.recallHome, 'config.json'), 'utf-8'));
      expect(cfg.hub.bind).toBe('127.0.0.1');
      expect(cfg.hub.port).toBe(7877);
      expect(readHubJson(sb)!.port).toBe(d.port);
      expect(d.port).toBeGreaterThan(0);
      // A second daemon on the same root is refused: the live owner is never stolen.
      const second = cli(sb, ['hub', 'serve', '--bind', '127.0.0.1', '--port', '0']);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('already running');
      expect(readHubJson(sb)!.pid).toBe(d.pid);
    } finally {
      const code = await d.stop();
      expect(code).toBe(0);
    }
    expect(readHubJson(sb)).toBeNull(); // released on SIGTERM
    const log = readFileSync(join(sb.recallHome, 'logs', 'hub.log'), 'utf-8');
    expect(log).toContain('hub-start');
    expect(log).toContain('hub-stop');
  }, 30_000);

  it('--detach spawns the daemon in the background and returns at once', async () => {
    const r = cli(sb, ['hub', 'serve', '--bind', '127.0.0.1', '--port', '0', '--detach']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('started in the background');
    const pid = Number(/pid (\d+)/.exec(r.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 15_000;
    let j = readHubJson(sb);
    while ((!j || j.pid !== pid || j.port <= 0) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
      j = readHubJson(sb);
    }
    expect(j).not.toBeNull();
    expect(j!.pid).toBe(pid);
    expect(j!.port).toBeGreaterThan(0);
    process.kill(pid, 'SIGTERM');
    const gone = Date.now() + 10_000;
    while (Date.now() < gone) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readHubJson(sb)).toBeNull();
    expect(readFileSync(join(sb.recallHome, 'logs', 'hub.log'), 'utf-8')).toContain('hub-stop');
  }, 30_000);

  it('--port 4242 is persisted, then an explicit --bind 127.0.0.1 keeps it', () => {
    // Persist happens BEFORE binding, so even a refused start (bad token state) records the values;
    // use a loopback bind so the only thing exercised is the merge-writer.
    issueToken(sb, 'cfg');
    const r = cli(sb, ['hub', 'serve', '--bind', '127.0.0.1', '--port', 'abc']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--port');
    const cfgBefore = JSON.parse(readFileSync(join(sb.recallHome, 'config.json'), 'utf-8'));
    expect(cfgBefore.hub.port).toBe(7877);
  });

  it('exits 1 with the recall install message when the codex re-key marker is missing', () => {
    const raw = new Database(sb.dbFile);
    raw.prepare('DELETE FROM schema_meta WHERE key = ?').run(CODEX_REKEY_MIGRATION_KEY);
    raw.close();
    const r = cli(sb, ['hub', 'serve', '--bind', '127.0.0.1', '--port', '0']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('migration pending');
    expect(r.stderr).toContain('recall install');
    expect(readHubJson(sb)).toBeNull();
    rmSync(sb.dbFile, { force: true });
  });
});
