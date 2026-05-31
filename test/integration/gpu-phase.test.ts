/**
 * gpu-phase — live GPU test + silent CPU fallback + persisted choice (§2.5).
 *
 * Stubs hasNvidiaGpu (via the `detect` injection) and the live-offload probe so
 * the phase is deterministic and never touches a real GPU or binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import { runGpuPhase, cudaBackendLib, stderrIndicatesOffload } from '../../src/installer/gpu.js';
import { readConfig } from '../../src/installer/config.js';

/** Create a fake staged CUDA backend lib at bin/libggml-cuda.so. */
function stageFakeCudaLib(): void {
  const lib = cudaBackendLib();
  mkdirSync(dirname(lib), { recursive: true });
  writeFileSync(lib, 'fake');
}

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

  it('GPU present + offload succeeds → GPU, reuses existing bin/libggml-cuda.so', async () => {
    stageFakeCudaLib(); // pre-staged CUDA backend lib present
    const res = await runGpuPhase({ platform: 'linux', arch: 'x64', detect: async () => true, probe: okProbe });
    expect(res.mode).toBe('gpu');
    expect(res.cudaAvailable).toBe('reuse-existing');
    // libDir is bin/ — the backend lib must sit beside the executable, not in a
    // separate dir the GGML_BACKEND_DL loader never scans.
    expect(res.libDir?.endsWith('bin')).toBe(true);
    const cfg = readConfig()!;
    expect(cfg.embedder.mode).toBe('gpu');
    expect(cfg.embedder.libDir?.endsWith('bin')).toBe(true);
  });

  it('GPU present + offload fails → silently falls back to CPU (no throw)', async () => {
    stageFakeCudaLib();
    const res = await runGpuPhase({ platform: 'linux', arch: 'x64', detect: async () => true, probe: failProbe });
    expect(res.mode).toBe('cpu');
    expect(res.reason).toBeTruthy();
    expect(readConfig()?.embedder.mode).toBe('cpu');
  });

  it("Linux + GPU, no staged lib → 'prebuilt': stages our lib into bin/, then adopts on a good probe", async () => {
    // A fresh CUDA box (no bin/libggml-cuda.so) fetches the version-matched
    // prebuilt instead of silently staying CPU. Stub the stager to drop the lib
    // beside the executable, as defaultStage now does.
    const res = await runGpuPhase({
      platform: 'linux', arch: 'x64',
      detect: async () => true,
      stage: async () => { stageFakeCudaLib(); return dirname(cudaBackendLib()); },
      probe: okProbe,
    });
    expect(res.cudaAvailable).toBe('prebuilt');
    expect(res.mode).toBe('gpu');
    expect(res.libDir?.endsWith('bin')).toBe(true);
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

  // Regression: only a REAL CUDA device/backend marker counts. The bare
  // "offloaded N/N layers to GPU" line prints from the requested -ngl even when
  // the CUDA backend never loaded (lib not beside the executable → CPU
  // fallback), so it must NOT be accepted. A prior fix keyed on it and adopted
  // GPU while embedding silently ran on CPU.
  describe('stderrIndicatesOffload', () => {
    it('accepts a real CUDA backend load (GGML_BACKEND_DL, lib found in bin/)', () => {
      const stderr = [
        'ggml_cuda_init: found 1 CUDA devices:',
        'load_backend: loaded CUDA backend from /home/u/.recall/bin/libggml-cuda.so',
        'llama_model_load_from_file_impl: using device CUDA0 (NVIDIA GeForce RTX 2060) - 5105 MiB free',
        'load_tensors: offloaded 13/13 layers to GPU',
        'load_tensors:        CUDA0 model buffer size =   114.91 MiB',
        'llama_context:      CUDA0 compute buffer size =  3776.00 MiB',
      ].join('\n');
      expect(stderrIndicatesOffload(stderr)).toBe(true);
    });

    it('detects the static-build form (ggml_cuda_init: found N CUDA devices)', () => {
      expect(stderrIndicatesOffload('ggml_cuda_init: found 1 CUDA devices')).toBe(true);
    });

    it('REJECTS the CPU-fallback that still prints "offloaded N/N layers to GPU"', () => {
      // This is exactly what a CPU run looks like when the CUDA backend lib was
      // not discoverable: the offload line is present, but the buffers are CPU
      // and there is no ggml_cuda_init / CUDA0 marker. Must be treated as CPU.
      const stderr = [
        'load_tensors: offloading 12 repeating layers to GPU',
        'load_tensors: offloaded 13/13 layers to GPU',
        'load_tensors:   CPU_Mapped model buffer size =   138.65 MiB',
        'llama_context:        CPU compute buffer size =  3752.06 MiB',
      ].join('\n');
      expect(/ggml_cuda_init/.test(stderr)).toBe(false);
      expect(stderrIndicatesOffload(stderr)).toBe(false);
    });

    it('rejects a CPU-only run (no offload lines)', () => {
      expect(stderrIndicatesOffload('load_tensors: CPU_Mapped model buffer size = 138.65 MiB')).toBe(false);
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
