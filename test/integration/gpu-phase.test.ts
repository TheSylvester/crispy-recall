/**
 * gpu-phase — live GPU test + silent CPU fallback + persisted choice (§2.5).
 *
 * Stubs hasNvidiaGpu (via the `detect` injection) and the live-offload probe so
 * the phase is deterministic and never touches a real GPU or binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import { runGpuPhase, binCudaDir } from '../../src/installer/gpu.js';
import { readConfig } from '../../src/installer/config.js';

let root: string;
let restore: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recall-gpu-'));
  restore = _setTestRoot(root);
});
afterEach(() => {
  restore?.();
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

const okProbe = async () => ({ cudaInit: true, vectorOk: true, stderr: 'ggml_cuda_init: found 1 device' });
const failProbe = async () => ({ cudaInit: false, vectorOk: false, stderr: 'CUDA error: no kernel image' });

describe('gpu-phase', () => {
  it('no GPU → CPU, never stages libs, never probes', async () => {
    let probed = false;
    const res = await runGpuPhase({
      platform: 'linux', arch: 'x64',
      detect: async () => false,
      probe: async () => { probed = true; return { cudaInit: false, vectorOk: false, stderr: '' }; },
    });
    expect(res.mode).toBe('cpu');
    expect(probed).toBe(false);
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });

  it('GPU present + offload succeeds → GPU, reuses existing ~/.recall/bin-cuda/', async () => {
    mkdirSync(binCudaDir(), { recursive: true }); // pre-built CUDA stack present
    const res = await runGpuPhase({ platform: 'linux', arch: 'x64', detect: async () => true, probe: okProbe });
    expect(res.mode).toBe('gpu');
    expect(res.cudaAvailable).toBe('reuse-existing');
    expect(res.libDir).toContain('bin-cuda');
    const cfg = readConfig()!;
    expect(cfg.embedder.mode).toBe('gpu');
    expect(cfg.embedder.libDir).toContain('bin-cuda');
  });

  it('GPU present + offload fails → silently falls back to CPU (no throw)', async () => {
    mkdirSync(binCudaDir(), { recursive: true });
    const res = await runGpuPhase({ platform: 'linux', arch: 'x64', detect: async () => true, probe: failProbe });
    expect(res.mode).toBe('cpu');
    expect(res.reason).toBeTruthy();
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });

  it('Linux without a bin-cuda build → CPU, never fetches a (nonexistent) prebuilt', async () => {
    let probed = false;
    const res = await runGpuPhase({
      platform: 'linux', arch: 'x64',
      detect: async () => true, // GPU detected …
      probe: async () => { probed = true; return { cudaInit: true, vectorOk: true, stderr: '' }; },
    });
    // … but no ~/.recall/bin-cuda/ → no usable CUDA libs → CPU, no probe/fetch.
    expect(res.mode).toBe('cpu');
    expect(res.cudaAvailable).toBe('none');
    expect(probed).toBe(false);
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });
});
