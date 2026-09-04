/**
 * Hub protocol + pure policy (spec §2.2, §2.3, §6): path rules, meta codec,
 * query body/argv rules, the bind rule, the systemd unit renderer, and the
 * `fullSweepDue` clock through an IN-PROCESS server with an injected clock.
 *
 * `_setTestRoot` does not cross a process boundary: every new suite that spawns
 * a child (hub daemon, `dist/recall.js`, `stop-hook.js`, `push-pending.js`,
 * `embed-pending.js`) MUST pass an explicit env: { ...process.env, RECALL_HOME:
 * <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote, CLAUDE_CONFIG_DIR: <tmp>/claude,
 * CODEX_HOME: <tmp>/codex }; a child that inherits the parent env resolves
 * `recallRoot()` to the live ~/.recall (paths.ts:35-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { _setTestRoot, recallRoot, remoteRoot } from '../../src/paths.js';
import { _resetDb } from '../../src/db.js';
import {
  HEADER_META, HEADER_STALE, HEADER_VERSION, HEADER_WIRE, KEY_RE, MAX_ARGV, MAX_ARGV_STRING, MAX_QUERY_BODY,
  QUERY_FLAG_ALLOWLIST, REJECTED_POSITIONALS, WIRE_VERSION, decodeMeta, encodeMeta, validateRelPath,
} from '../../src/hub/protocol.js';
import { buildHubArgv, validateQueryBody } from '../../src/hub/query.js';
import { checkBindPolicy, classifyBind, startHubServer } from '../../src/hub/server.js';
import { resolveMirrorPath, mirrorFilePath } from '../../src/hub/mirror.js';
import { hubUnitPath, renderHubUnit, runInstallService } from '../../src/hub/service.js';
import { issueHubToken } from '../../src/hub/tokens.js';
import { req, authHeaders } from './helpers/hub-harness.js';

const win32 = platform() === 'win32';
let sandbox: string;
let restore: (() => void) | undefined;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-hub-proto-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RECALL_REMOTE_ROOT', 'XDG_CONFIG_HOME']) prevEnv[k] = process.env[k];
  process.env['CLAUDE_CONFIG_DIR'] = join(sandbox, 'claude');
  process.env['CODEX_HOME'] = join(sandbox, 'codex');
  process.env['RECALL_REMOTE_ROOT'] = join(sandbox, '.recall', 'remote');
  process.env['XDG_CONFIG_HOME'] = join(sandbox, 'xdg');
  _resetDb();
});

afterAll(() => {
  restore?.();
  _resetDb();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('sandbox guard', () => {
  it('recallRoot() and remoteRoot() sit under tmpdir before any write', () => {
    expect(resolve(recallRoot()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(remoteRoot()).startsWith(resolve(tmpdir()))).toBe(true);
  });
});

describe('protocol constants (frozen names)', () => {
  it('exports the frozen values', () => {
    expect(WIRE_VERSION).toBe(1);
    expect(HEADER_WIRE).toBe('x-recall-wire');
    expect(HEADER_VERSION).toBe('x-recall-version');
    expect(HEADER_META).toBe('x-recall-meta');
    expect(HEADER_STALE).toBe('x-recall-stale');
    expect(MAX_ARGV).toBe(64);
    expect(MAX_ARGV_STRING).toBe(4096);
    expect(MAX_QUERY_BODY).toBe(64 * 1024);
    expect([...QUERY_FLAG_ALLOWLIST].sort()).toEqual(['--all', '--limit', '--list', '--no-idf', '--offset', '--raw', '--raw-messages', '--recent', '--reverse', '--since', '--until']);
    expect([...REJECTED_POSITIONALS].sort()).toEqual(['backfill', 'doctor', 'hub', 'install', 'push', 'repair', 'status', 'statusline', 'uninstall']);
    expect(KEY_RE.test('git:' + 'a'.repeat(40))).toBe(true);
    expect(KEY_RE.test('origin:github.com/a/b')).toBe(true);
    expect(KEY_RE.test('path:/x')).toBe(true);
    expect(KEY_RE.test('git:short')).toBe(false);
  });
});

describe('path rules (validateRelPath)', () => {
  it('accepts a plain claude path and a Unicode segment', () => {
    expect(validateRelPath('claude', 'projects/-home-u-dev/abc.jsonl').ok).toBe(true);
    expect(validateRelPath('claude', 'projects/日本語/ünïcode-☃.jsonl').ok).toBe(true);
    expect(validateRelPath('codex', 'sessions/2026/09/04/rollout-x.jsonl').ok).toBe(true);
  });
  it('rejects a control character', () => {
    expect(validateRelPath('claude', 'projects/a\x01b/c.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'projects/a/c\nd.jsonl').ok).toBe(false);
  });
  it('rejects . and .. segments', () => {
    expect(validateRelPath('claude', 'projects/../x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'projects/./x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'projects/a/../../x.jsonl').ok).toBe(false);
  });
  it('rejects a leading slash, a drive letter, a ? and a //?/C:/ prefix', () => {
    expect(validateRelPath('claude', '/projects/x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'C:projects/x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'c:/projects/x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'projects/a?b/x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', '//?/C:/Users/x/.claude/projects/p/x.jsonl').ok).toBe(false);
  });
  it('rejects the wrong vendor prefix, a non-.jsonl, an empty segment and empty input', () => {
    expect(validateRelPath('claude', 'sessions/x.jsonl').ok).toBe(false);
    expect(validateRelPath('codex', 'projects/x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'projects/x.json').ok).toBe(false);
    expect(validateRelPath('claude', 'projects//x.jsonl').ok).toBe(false);
    expect(validateRelPath('claude', 'projects/x.jsonl/').ok).toBe(false);
    expect(validateRelPath('claude', '').ok).toBe(false);
  });
  it('resolveMirrorPath normalizes backslashes first and contains the result', () => {
    const r = resolveMirrorPath('h1', 'claude', 'projects/a\\b.jsonl');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rel).toBe('projects/a/b.jsonl');
      expect(r.abs).toBe(mirrorFilePath('h1', 'claude', 'projects/a/b.jsonl'));
      expect(r.abs.startsWith(remoteRoot().replace(/\\/g, '/') + '/h1/claude/')).toBe(true);
    }
    expect(resolveMirrorPath('h1', 'claude', 'projects/..\\..\\x.jsonl').ok).toBe(false);
    expect(resolveMirrorPath('h1', 'claude', '..%2Fx.jsonl').ok).toBe(false);
  });
});

describe('meta codec (decodeMeta)', () => {
  it('round-trips and returns Error values, never throws', () => {
    const m = { cwd: '/home/u/p', key: 'path:/home/u/p', hook: { isSubagent: false, payloadSessionId: 's' }, final: true };
    const d = decodeMeta(encodeMeta(m));
    expect(d).toEqual(m);
    expect(decodeMeta(undefined)).toBeInstanceOf(Error);
    expect(decodeMeta('not*base64url')).toBeInstanceOf(Error);
    expect(decodeMeta(Buffer.from('[1]').toString('base64url'))).toBeInstanceOf(Error);
    expect(decodeMeta(Buffer.from('{"cwd":1}').toString('base64url'))).toBeInstanceOf(Error);
    expect(decodeMeta(Buffer.from('{"key":"path:/x"}').toString('base64url'))).toBeInstanceOf(Error); // key without cwd
    expect(decodeMeta(Buffer.from('{"cwd":"/x","key":"nope"}').toString('base64url'))).toBeInstanceOf(Error);
    expect(decodeMeta(Buffer.from('{"cwd":"/x","hook":{}}').toString('base64url'))).toBeInstanceOf(Error);
    expect(decodeMeta(Buffer.from('{"cwd":"/x","reset":"yes"}').toString('base64url'))).toBeInstanceOf(Error);
    expect(decodeMeta(encodeMeta({}))).toEqual({});
    const big = encodeMeta({ cwd: 'x'.repeat(17 * 1024) });
    expect(decodeMeta(big)).toBeInstanceOf(Error);
  });
});

describe('query body + argv rules', () => {
  it('validates the body limits', () => {
    expect(validateQueryBody({ argv: ['a'], cwd: '/x' }).ok).toBe(true);
    expect(validateQueryBody({ argv: 'a', cwd: '/x' }).ok).toBe(false);
    expect(validateQueryBody({ argv: new Array(65).fill('a'), cwd: '/x' }).ok).toBe(false);
    expect(validateQueryBody({ argv: ['a'.repeat(4097)], cwd: '/x' }).ok).toBe(false);
    expect(validateQueryBody({ argv: ['a\0b'], cwd: '/x' }).ok).toBe(false);
    expect(validateQueryBody({ argv: ['a'], cwd: '' }).ok).toBe(false);
    expect(validateQueryBody({ argv: ['a'], cwd: '-rf' }).ok).toBe(false);
    expect(validateQueryBody({ argv: ['a'], cwd: '/x', key: 'bogus' }).ok).toBe(false);
    expect(validateQueryBody({ argv: ['a'], cwd: '/x', key: 'git:' + 'b'.repeat(40) }).ok).toBe(true);
  });
  it('rejects --project / --project-key and non-allowlisted flags and positionals', () => {
    const r = buildHubArgv({ argv: ['x', '--project', '/y'], cwd: '/x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('--project must be resolved on the satellite');
    expect(buildHubArgv({ argv: ['x', '--project-key', 'path:/y'], cwd: '/x' }).ok).toBe(false);
    expect(buildHubArgv({ argv: ['x', '--help'], cwd: '/x' }).ok).toBe(false);
    expect(buildHubArgv({ argv: ['x', '--vendor', 'codex'], cwd: '/x' }).ok).toBe(false);
    for (const p of REJECTED_POSITIONALS) expect(buildHubArgv({ argv: [p], cwd: '/x' }).ok).toBe(false);
  });
  it('strips --context <n>, appends scope + --no-catchup, and never scopes with --all', () => {
    const scoped = buildHubArgv({ argv: ['foo', '--context', '3', '--limit', '5'], cwd: '/home/u/p/', key: 'path:/home/u/p' });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.argv).toEqual(['foo', '--limit', '5', '--project-key', 'path:/home/u/p', '--project', '/home/u/p', '--no-catchup']);
    const noKey = buildHubArgv({ argv: ['foo'], cwd: '/home/u/p' });
    if (noKey.ok) expect(noKey.argv).toEqual(['foo', '--project', '/home/u/p', '--no-catchup']);
    const all = buildHubArgv({ argv: ['foo', '--all'], cwd: '/home/u/p', key: 'path:/home/u/p' });
    if (all.ok) {
      expect(all.argv).toEqual(['foo', '--all', '--no-catchup']);
      expect(all.argv.filter((a) => a === '--project' || a === '--project-key')).toEqual([]);
    }
    // A value that spells a command name is a VALUE, not a positional.
    expect(buildHubArgv({ argv: ['foo', '--since', 'install'], cwd: '/x' }).ok).toBe(true);
  });
});

describe('bind rule', () => {
  it('classifies ANY / loopback / other', () => {
    for (const b of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '[::]', '', undefined]) expect(classifyBind(b)).toBe('any');
    for (const b of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) expect(classifyBind(b)).toBe('loopback');
    expect(classifyBind('100.79.117.97')).toBe('other');
  });
  it('refuses ANY without the flag naming both remedies, and non-loopback without tokens', () => {
    for (const b of ['::', undefined, '']) {
      const r = checkBindPolicy(b, { publicOk: false, tokenCount: 3 });
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.message).toContain('--i-know-this-is-public'); expect(r.message).toContain('recall hub token'); }
    }
    const flagNoToken = checkBindPolicy('::', { publicOk: true, tokenCount: 0 });
    expect(flagNoToken.ok).toBe(false);
    if (!flagNoToken.ok) expect(flagNoToken.message).toContain('recall hub token');
    const other = checkBindPolicy('100.79.117.97', { publicOk: false, tokenCount: 0 });
    expect(other.ok).toBe(false);
    expect(checkBindPolicy('100.79.117.97', { publicOk: false, tokenCount: 1 }).ok).toBe(true);
    expect(checkBindPolicy('127.0.0.1', { publicOk: false, tokenCount: 0 }).ok).toBe(true);
    const any = checkBindPolicy(undefined, { publicOk: true, tokenCount: 1 });
    expect(any.ok && any.bind).toBe('::');
  });
});

describe('install-service unit text (never reaches systemctl)', () => {
  it('renders the unit and writes it under XDG_CONFIG_HOME with apply:false', () => {
    const unit = renderHubUnit();
    expect(unit).toContain(`ExecStart="${process.execPath}"`);
    expect(unit).toContain('recall.js" hub serve');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('TimeoutStopSec=15');
    expect(unit).toContain('WantedBy=default.target');
    expect(hubUnitPath().startsWith(join(sandbox, 'xdg'))).toBe(true);
    const r = runInstallService({ apply: false, platform: 'linux' });
    expect(r.applied).toBe(false);
    expect(r.unitPath).not.toBeNull();
    expect(r.unitPath!.startsWith(join(sandbox, 'xdg'))).toBe(true);
    expect(readFileSync(r.unitPath!, 'utf-8')).toBe(unit);
    const mac = runInstallService({ apply: false, platform: 'darwin' });
    expect(mac.unitPath).toBeNull();
    expect(mac.messages.join('\n')).toContain('launchd');
  });
});

describe.skipIf(win32)('fullSweepDue clock (in-process server, injected now)', () => {
  it('flips after 24 h and a full:true manifest resets it', async () => {
    let clock = Date.UTC(2026, 8, 4, 12, 0, 0);
    const token = issueHubToken('clockhost');
    const h = await startHubServer({
      bind: '127.0.0.1', port: 0, now: () => clock, sweepMs: null, startupSweep: false,
    });
    try {
      const post = (full: boolean) => req(`http://127.0.0.1:${h.port}`, {
        method: 'POST', path: '/v1/push/manifest', headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ vendor: 'claude', full, files: [] }),
      });
      const first = await post(false);
      expect(first.status).toBe(200);
      expect(first.json().fullSweepDue).toBe(true); // never seen a full manifest
      expect(first.json().host).toBe('clockhost');
      const full = await post(true);
      expect(full.json().fullSweepDue).toBe(false);
      clock += 23 * 60 * 60 * 1000;
      expect((await post(false)).json().fullSweepDue).toBe(false);
      clock += 2 * 60 * 60 * 1000; // 25 h after the full manifest
      expect((await post(false)).json().fullSweepDue).toBe(true);
    } finally {
      await h.stop();
    }
    expect(existsSync(join(recallRoot(), 'run', 'hub.json'))).toBe(false); // released
  });
});
