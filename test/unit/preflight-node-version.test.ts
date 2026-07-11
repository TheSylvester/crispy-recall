/**
 * preflight Node-version gate.
 *
 * recall ships prebuilt better-sqlite3 bindings only for Node 22 LTS (>=22.16)
 * and Node >=24, matching package.json `engines` (">=22.16.0 <23 || >=24.0.0")
 * and the README ("Node 23 is unsupported"). runPreflight must FAIL fast on any
 * other Node instead of letting the install reach a cryptic native-load error.
 *
 * The running Node version is injected via opts.nodeVersion so the boundaries run
 * on any host. Sandboxed via _setTestRoot + CLAUDE_CONFIG_DIR and offline so no
 * production ~/.recall or ~/.claude is touched and no network is hit. platform is
 * pinned to linux so the macOS floor branch is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import { runPreflight } from '../../src/installer/preflight.js';

let sandbox: string;
let restore: () => void;
let prevClaude: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-node-gate-'));
  restore = _setTestRoot(join(sandbox, '.recall'));
  const claudeDir = join(sandbox, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
});

afterEach(() => {
  restore?.();
  if (prevClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = prevClaude;
  rmSync(sandbox, { recursive: true, force: true });
});

function opts(nodeVersion: string) {
  return {
    offline: true,
    gpuDetect: async () => false,
    platform: 'linux' as NodeJS.Platform,
    arch: 'x64',
    nodeVersion,
  };
}

function nodeFailure(report: Awaited<ReturnType<typeof runPreflight>>) {
  return report.failures.find((f) => f.check === 'runtime.node');
}

describe('preflight Node-version gate', () => {
  it.each(['v20.19.0', 'v21.7.3', 'v22.0.0', 'v22.15.1'])(
    'FAILs below the 22.16 floor (%s)',
    async (version) => {
      const report = await runPreflight(opts(version));
      const fail = nodeFailure(report);
      expect(fail).toBeDefined();
      expect(fail!.severity).toBe('FAIL');
      expect(fail!.message).toContain(version);
    },
  );

  it.each(['v22.16.0', 'v22.18.0', 'v22.20.5'])(
    'passes on Node 22 LTS at/above 22.16 (%s)',
    async (version) => {
      const report = await runPreflight(opts(version));
      expect(nodeFailure(report)).toBeUndefined();
      expect(report.runtime.node).toBe(version);
    },
  );

  it('FAILs on Node 23 with a no-prebuilt-binding note', async () => {
    const report = await runPreflight(opts('v23.5.0'));
    const fail = nodeFailure(report);
    expect(fail).toBeDefined();
    expect(fail!.message).toContain('Node 23 has no prebuilt SQLite binding');
  });

  it.each(['v24.0.0', 'v25.2.1'])('passes on Node >=24 (%s)', async (version) => {
    const report = await runPreflight(opts(version));
    expect(nodeFailure(report)).toBeUndefined();
  });
});
