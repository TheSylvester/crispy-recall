/**
 * extractArchive — timeout + OS-unzip fallback (macOS 0.2.1 ship-blocker).
 *
 * During the 2026-07-06 rented-Mac acceptance, `recall install` hung ~18 min:
 * extract-zip/yauzl wedged mid-extraction and — unlike downloadFile() — had no
 * timeout of its own, so a stalled extract bricked the whole install with only a
 * spinner. extractArchive() now races extract-zip against EXTRACT_TIMEOUT_MS and
 * falls back to the platform's native unzip.
 *
 * These tests wrap the real extract-zip (happy path exercises the actual lib)
 * and override it per-case to force the timeout / failure branches, asserting the
 * fallback both fires and actually produces the files. Skipped where the `zip`/
 * `unzip` CLIs are absent (e.g. bare Windows CI), since the fallback under test
 * there is PowerShell's Expand-Archive rather than unzip.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Wrap the real extract-zip so the happy path exercises the actual library while
// individual tests can override behaviour for one call via mock*Once.
vi.mock('extract-zip', async (importOriginal) => {
  const actual = await importOriginal<{ default: (src: string, opts: { dir: string }) => Promise<void> }>();
  return { default: vi.fn(actual.default) };
});

import extract from 'extract-zip';
import {
  buildUnzipInvocations, extractArchive, installExtractedBinaries, withTimeout,
} from '../../src/recall/embedder.js';

function toolAvailable(cmd: string): boolean {
  try {
    execFileSync(cmd, ['-h'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as { code?: string })?.code !== 'ENOENT';
  }
}

const HAVE_ZIP_TOOLS = toolAvailable('zip') && toolAvailable('unzip');

describe('withTimeout', () => {
  it('passes a fast promise through', async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, 'fast')).resolves.toBe(42);
  });

  it('rejects a stuck promise promptly instead of hanging', async () => {
    const start = Date.now();
    await expect(
      withTimeout(new Promise<never>(() => { /* never settles */ }), 50, 'stuck'),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

// Pure argv assembly — runs on every platform, so it covers the win32 and macOS
// fallback branches that the CLI-gated extractArchive tests below never execute.
describe('buildUnzipInvocations', () => {
  it('win32 → a single Expand-Archive invocation with -Force', () => {
    expect(buildUnzipInvocations('win32', 'C:\\a\\x.zip', 'C:\\a\\out')).toEqual([{
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        "Expand-Archive -LiteralPath 'C:\\a\\x.zip' -DestinationPath 'C:\\a\\out' -Force"],
    }]);
  });

  it('win32 → doubles embedded single quotes so apostrophe home paths cannot break the PS literal', () => {
    const inv = buildUnzipInvocations(
      'win32',
      "C:\\Users\\O'Brien\\.recall\\bin\\x.zip",
      "C:\\Users\\O'Brien\\tmp\\out",
    );
    expect(inv[0].args[3]).toBe(
      "Expand-Archive -LiteralPath 'C:\\Users\\O''Brien\\.recall\\bin\\x.zip' " +
      "-DestinationPath 'C:\\Users\\O''Brien\\tmp\\out' -Force",
    );
  });

  it('darwin → unzip first, then ditto as a second try', () => {
    expect(buildUnzipInvocations('darwin', '/a/x.zip', '/a/out')).toEqual([
      { cmd: 'unzip', args: ['-o', '-q', '/a/x.zip', '-d', '/a/out'] },
      { cmd: 'ditto', args: ['-x', '-k', '/a/x.zip', '/a/out'] },
    ]);
  });

  it('linux → unzip only', () => {
    expect(buildUnzipInvocations('linux', '/a/x.zip', '/a/out')).toEqual([
      { cmd: 'unzip', args: ['-o', '-q', '/a/x.zip', '-d', '/a/out'] },
    ]);
  });
});

describe.skipIf(!HAVE_ZIP_TOOLS)('extractArchive', () => {
  let fixturesRoot: string;
  let zipPath: string;
  let workDir: string;

  beforeAll(() => {
    fixturesRoot = mkdtempSync(join(tmpdir(), 'recall-extract-fix-'));
    const srcDir = join(fixturesRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'llama-embedding'), 'fake-embedding-binary');
    writeFileSync(join(srcDir, 'libggml-metal.dylib'), 'fake-metal-lib');
    zipPath = join(fixturesRoot, 'llama-cpu.zip');
    // -j junks paths → flat entries, mirroring the b5300 flat-root layout.
    execFileSync('zip', ['-q', '-j', zipPath, join(srcDir, 'llama-embedding'), join(srcDir, 'libggml-metal.dylib')]);
  });

  afterAll(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'recall-extract-work-'));
    vi.mocked(extract).mockClear();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('uses extract-zip on the happy path and returns the base dir', async () => {
    const dir = await extractArchive(zipPath, workDir, 'llama-cpu.zip');

    expect(dir).toBe(workDir);
    expect(vi.mocked(extract)).toHaveBeenCalledTimes(1);
    expect(existsSync(join(workDir, 'llama-embedding'))).toBe(true);
    expect(existsSync(join(workDir, 'libggml-metal.dylib'))).toBe(true);
  });

  it('falls back to system unzip when extract-zip wedges, and still produces the files', async () => {
    // Simulate the live hang: extract-zip never settles.
    vi.mocked(extract).mockReturnValueOnce(new Promise<void>(() => { /* wedged */ }));

    const start = Date.now();
    const dir = await extractArchive(zipPath, workDir, 'llama-cpu.zip', 100);

    // Fell back into a fresh subdir, and completed far faster than the ~18 min hang.
    expect(dir).toBe(join(workDir, '__os_unzip__'));
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(existsSync(join(dir, 'llama-embedding'))).toBe(true);
    expect(existsSync(join(dir, 'libggml-metal.dylib'))).toBe(true);
  });

  it('falls back to system unzip when extract-zip throws', async () => {
    vi.mocked(extract).mockReturnValueOnce(Promise.reject(new Error('boom')));

    const dir = await extractArchive(zipPath, workDir, 'llama-cpu.zip');

    expect(dir).toBe(join(workDir, '__os_unzip__'));
    expect(existsSync(join(dir, 'llama-embedding'))).toBe(true);
  });

  it('installExtractedBinaries copies from the dir extractArchive returns on the fallback path', async () => {
    // The wedge path returns the __os_unzip__ subdir; the consumer must read from
    // THAT dir, not the parent temp dir — otherwise the fallback copies nothing.
    vi.mocked(extract).mockReturnValueOnce(new Promise<void>(() => { /* wedged */ }));
    const extractedDir = await extractArchive(zipPath, workDir, 'llama-cpu.zip', 100);
    const destDir = join(workDir, 'dest');

    const copied = await installExtractedBinaries(extractedDir, destDir);

    expect(copied).toBe(2);
    expect(existsSync(join(destDir, 'llama-embedding'))).toBe(true);
    expect(existsSync(join(destDir, 'libggml-metal.dylib'))).toBe(true);
  });
});
