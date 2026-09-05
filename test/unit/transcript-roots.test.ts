/**
 * The shared transcript-root resolver and its hub guard (U2 item 1).
 *
 * The guard only fires on Linux, only for a DrvFs override (`/mnt/<x>/…`) and
 * only when `run/hub-hosts.json` names at least one satellite. Every other
 * installation keeps the override — including this repo's own tests, whose
 * roots live under the temp directory.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { _setTestRoot } from '../../src/paths.js';
import { hubHostsPath } from '../../src/hub/runtime.js';
import {
  _resetRootWarnings, claudeRoot, codexRoot, defaultClaudeRoot, defaultCodexRoot, transcriptRoots,
} from '../../src/recall/transcript-roots.js';

const linux = process.platform === 'linux';
const DRVFS_CODEX = '/mnt/c/Users/silve/.codex';
const DRVFS_CLAUDE = '/mnt/c/Users/silve/.claude';

let sandbox: string;
let restore: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeHosts(body: string): void {
  mkdirSync(dirname(hubHostsPath()), { recursive: true });
  writeFileSync(hubHostsPath(), body);
}

function registerHost(name: string): void {
  writeHosts(JSON.stringify({ [name]: { refusedCollisions: 0 } }));
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-roots-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  setEnv('CLAUDE_CONFIG_DIR', undefined);
  setEnv('CODEX_HOME', undefined);
  _resetRootWarnings();
});

afterEach(() => {
  restore?.(); restore = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('transcript roots — defaults', () => {
  it('fall back to the home directory with no override', () => {
    expect(claudeRoot()).toBe(join(homedir(), '.claude'));
    expect(codexRoot()).toBe(join(homedir(), '.codex'));
    expect(defaultClaudeRoot()).toBe(claudeRoot());
    expect(defaultCodexRoot()).toBe(codexRoot());
    expect(transcriptRoots()).toEqual([
      { vendor: 'claude', root: claudeRoot() },
      { vendor: 'codex', root: codexRoot() },
    ]);
  });

  it('honour the override on a plain install (no host record)', () => {
    setEnv('CODEX_HOME', join(sandbox, 'codex'));
    setEnv('CLAUDE_CONFIG_DIR', join(sandbox, 'claude'));
    expect(codexRoot()).toBe(join(sandbox, 'codex'));
    expect(claudeRoot()).toBe(join(sandbox, 'claude'));
  });

  it('honour a DrvFs override when no host is registered', () => {
    setEnv('CODEX_HOME', DRVFS_CODEX);
    expect(codexRoot()).toBe(DRVFS_CODEX);
  });
});

describe.skipIf(!linux)('transcript roots — hub guard', () => {
  it('ignores a DrvFs override on a hub with a registered host', () => {
    registerHost('silverera2');
    setEnv('CODEX_HOME', DRVFS_CODEX);
    setEnv('CLAUDE_CONFIG_DIR', DRVFS_CLAUDE);
    expect(codexRoot()).toBe(defaultCodexRoot());
    expect(claudeRoot()).toBe(defaultClaudeRoot());
  });

  it('keeps an override outside /mnt/<x>/ even on a hub', () => {
    registerHost('silverera2');
    const local = join(sandbox, 'x');
    setEnv('CODEX_HOME', local);
    expect(codexRoot()).toBe(local);
    // /tmp/x is not DrvFs either, whatever the sandbox path is.
    setEnv('CODEX_HOME', '/tmp/x');
    expect(codexRoot()).toBe('/tmp/x');
  });

  it('warns exactly once per process, naming the host and the variable', () => {
    registerHost('silverera2');
    setEnv('CODEX_HOME', DRVFS_CODEX);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    codexRoot();
    codexRoot();
    codexRoot();
    const lines = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('CODEX_HOME'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[warn]');
    expect(lines[0]).toContain(`ignoring CODEX_HOME=${DRVFS_CODEX}`);
    expect(lines[0]).toContain('this hub serves satellite silverera2');
    expect(lines[0]).toContain('set the variable elsewhere or unset it');
  });

  it('does not guard when the host record cannot be read', () => {
    writeHosts('not json at all');
    setEnv('CODEX_HOME', DRVFS_CODEX);
    expect(codexRoot()).toBe(DRVFS_CODEX);
  });
});
