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
import { runGpuPhase, binCudaDir, stderrIndicatesOffload } from '../../src/installer/gpu.js';
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

  it("Linux + GPU, no bin-cuda → 'prebuilt': stages our lib, then adopts on a good probe", async () => {
    // Part B: a fresh CUDA box (no ~/.recall/bin-cuda/) now fetches the version-
    // matched prebuilt instead of silently staying CPU. Stub the stager.
    const res = await runGpuPhase({
      platform: 'linux', arch: 'x64',
      detect: async () => true,
      stage: async () => { const d = binCudaDir(); mkdirSync(d, { recursive: true }); return d; },
      probe: okProbe,
    });
    expect(res.cudaAvailable).toBe('prebuilt');
    expect(res.mode).toBe('gpu');
    expect(res.libDir).toContain('bin-cuda');
    expect(readConfig()?.embedder.mode).toBe('gpu');
  });

  it("Linux 'prebuilt' staging unavailable (offline / download fails) → silent CPU, no probe", async () => {
    let probed = false;
    const res = await runGpuPhase({
      platform: 'linux', arch: 'x64',
      detect: async () => true,
      stage: async () => null, // could not fetch the asset
      probe: async () => { probed = true; return { cudaInit: true, vectorOk: true, stderr: '' }; },
    });
    expect(res.cudaAvailable).toBe('prebuilt');
    expect(res.mode).toBe('cpu');
    expect(res.reason).toBeTruthy();
    // M3: the persisted reason is honest about WHY GPU did not engage — it needs
    // both the published prebuilt asset and a system CUDA runtime.
    expect(res.reason).toMatch(/published|prebuilt/i);
    expect(res.reason).toMatch(/libcudart|libcublas|CUDA runtime/i);
    expect(probed).toBe(false); // never probes when staging failed
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });

  // Regression: the live probe must recognise GPU offload for BOTH llama.cpp
  // build flavors. The prebuilt Linux asset (GGML_BACKEND_DL) prints only
  // "offloaded N/N layers to GPU" with no ggml_cuda_init line — checking only
  // for ggml_cuda_init made every Linux/WSL auto-fetch install fall back to CPU
  // despite a working GPU (verified against the real published v0.1.0 asset).
  describe('stderrIndicatesOffload', () => {
    it('detects the GGML_BACKEND_DL form (offloaded N/N layers to GPU, no ggml_cuda_init)', () => {
      const stderr = [
        'load_tensors: offloading 12 repeating layers to GPU',
        'load_tensors: offloading output layer to GPU',
        'load_tensors: offloaded 13/13 layers to GPU',
        'load_tensors:   CPU_Mapped model buffer size =   138.65 MiB',
      ].join('\n');
      expect(/ggml_cuda_init/.test(stderr)).toBe(false); // the string the old check required is absent
      expect(stderrIndicatesOffload(stderr)).toBe(true);
    });

    it('detects the static-build form (ggml_cuda_init: found N CUDA devices)', () => {
      expect(stderrIndicatesOffload('ggml_cuda_init: found 1 CUDA devices')).toBe(true);
    });

    it('rejects a CPU-only run (no offload lines)', () => {
      expect(stderrIndicatesOffload('load_tensors: CPU_Mapped model buffer size = 138.65 MiB')).toBe(false);
    });

    it('rejects "offloaded 0/N layers to GPU" (nothing actually offloaded)', () => {
      expect(stderrIndicatesOffload('load_tensors: offloaded 0/13 layers to GPU')).toBe(false);
    });
  });

  it("offline + GPU + no pre-staged lib → CPU via defaultStage (no network, no probe)", async () => {
    let probed = false;
    const res = await runGpuPhase({
      platform: 'linux', arch: 'x64',
      offline: true,
      detect: async () => true,
      // no stage stub → exercises defaultStage, which returns null offline-absent
      probe: async () => { probed = true; return { cudaInit: true, vectorOk: true, stderr: '' }; },
    });
    expect(res.mode).toBe('cpu');
    expect(probed).toBe(false);
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });
});
