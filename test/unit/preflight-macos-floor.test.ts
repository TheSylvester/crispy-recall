/**
 * preflight macOS floor — defect 1 (OS-version floor for the b5300 binaries).
 *
 * The pinned llama.cpp b5300 macOS binaries have an LC_BUILD_VERSION minos of
 * 14.0 (arm64) / 13.7 (x64); an older macOS cannot dlopen them. runPreflight's
 * darwin branch must FAIL below that floor (with an actionable message) instead
 * of letting the install reach the cryptic mid-phase `Binary validation failed`.
 *
 * Fully injected (platform/arch/macosProductVersion) so it runs on any host;
 * sandboxed via _setTestRoot + CLAUDE_CONFIG_DIR so no production ~/.recall or
 * ~/.claude is touched, and offline so no network is hit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import { runPreflight } from '../../src/installer/preflight.js';
import { MACOS_MIN_VERSION } from '../../src/recall/embedder.js';

let sandbox: string;
let restore: () => void;
let prevClaude: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-macos-floor-'));
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

/** Common injected opts: offline (no network), GPU absent, version injected. */
function opts(platform: NodeJS.Platform, arch: string, version: string | null) {
  return {
    offline: true,
    gpuDetect: async () => false,
    platform,
    arch,
    macosProductVersion: async () => version,
  };
}

function macosFloorFailure(report: Awaited<ReturnType<typeof runPreflight>>) {
  return report.failures.find((f) => f.check === 'platform.macos-version');
}
function macosFloorWarning(report: Awaited<ReturnType<typeof runPreflight>>) {
  return report.warnings.find((w) => w.check === 'platform.macos-version');
}

describe('preflight macOS OS-version floor', () => {
  it('FAILs on arm64 below the 14.0 floor', async () => {
    const report = await runPreflight(opts('darwin', 'arm64', '13.6'));
    const fail = macosFloorFailure(report);
    expect(fail).toBeDefined();
    expect(fail!.severity).toBe('FAIL');
    expect(fail!.message).toContain('13.6');
    expect(fail!.message).toContain(MACOS_MIN_VERSION.arm64);
    expect(fail!.remediation).toContain(MACOS_MIN_VERSION.arm64);
  });

  it('passes on arm64 exactly at the 14.0 floor', async () => {
    const report = await runPreflight(opts('darwin', 'arm64', MACOS_MIN_VERSION.arm64));
    expect(macosFloorFailure(report)).toBeUndefined();
  });

  it('passes on arm64 above the floor (numeric compare, not lexical)', async () => {
    // 14.10 > 14.9 numerically — a lexical string compare would get this wrong.
    const report = await runPreflight(opts('darwin', 'arm64', '14.10'));
    expect(macosFloorFailure(report)).toBeUndefined();
  });

  it('FAILs on x64 below the 13.7 floor', async () => {
    const report = await runPreflight(opts('darwin', 'x64', '13.5'));
    const fail = macosFloorFailure(report);
    expect(fail).toBeDefined();
    expect(fail!.message).toContain(MACOS_MIN_VERSION.x64);
  });

  it('passes on x64 exactly at the 13.7 floor', async () => {
    const report = await runPreflight(opts('darwin', 'x64', MACOS_MIN_VERSION.x64));
    expect(macosFloorFailure(report)).toBeUndefined();
  });

  it('WARNs (never crashes) when the macOS version cannot be read', async () => {
    const report = await runPreflight(opts('darwin', 'arm64', null));
    expect(macosFloorFailure(report)).toBeUndefined();
    expect(macosFloorWarning(report)).toBeDefined();
  });

  it('is a no-op on non-macOS platforms', async () => {
    const report = await runPreflight(opts('linux', 'x64', '13.0'));
    expect(macosFloorFailure(report)).toBeUndefined();
    expect(macosFloorWarning(report)).toBeUndefined();
  });
});
