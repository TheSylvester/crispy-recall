/**
 * GPU phase — detect, classify, stage, live-test, adopt-or-fall-back.
 *
 * "GPU support" for recall is NOT a different binary: the CPU `llama-embedding`
 * dlopens `libggml-cuda.so` at runtime when present. So adopting the GPU means
 * (a) the right libs are reachable on the dynamic-library search path and
 * (b) `-ngl 999` is passed. This module decides whether that is possible on the
 * current platform, proves it with a LIVE offload test, and persists the verdict
 * to ~/.recall/config.json (config.ts).
 *
 * Platform policy (Day 5):
 *   - Windows x64 + NVIDIA → prebuilt CUDA artifact (already fetched adjacent to
 *     the binary by embedder.ensureBinary when a GPU is present); live-test.
 *   - Linux x64 + NVIDIA → reuse an existing ~/.recall/bin-cuda/ build if present
 *     (live-test); otherwise CPU. NEVER build from source, NEVER claim a
 *     nonexistent llama.cpp Linux CUDA prebuilt. (§8 prebuilt fetch is deferred.)
 *   - macOS arm64 → Metal is in the standard build; adopt GPU, no extra libs,
 *     no live-test.
 *   - everything else / no GPU / probe timeout → CPU (silent, expected).
 *
 * A FAIL here is impossible: absence or failure always yields a clean CPU verdict.
 *
 * @module installer/gpu
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { platform as osPlatform, arch as osArch } from 'node:os';
import { hasNvidiaGpu, getBinaryPath, getModelPath } from '../recall/embedder.js';
import { binDir, recallRoot } from '../paths.js';
import { writeEmbedderConfig, readConfig } from './config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const EXPECTED_DIMS = 768;
const OFFLOAD_TIMEOUT_MS = 15_000;
const DEFAULT_NGL = 999;

export type CudaAvailability = 'prebuilt' | 'reuse-existing' | 'metal' | 'none';

export interface GpuInfo {
  detected: boolean;
  vendor: string; // 'nvidia' | 'none'
  vram?: string;
  cudaAvailable: CudaAvailability;
  plannedMode: 'gpu' | 'cpu';
  persistedMode?: 'gpu' | 'cpu';
}

/** Result of a single LIVE offload probe (one llama-embedding run with -ngl). */
export interface OffloadProbeResult {
  cudaInit: boolean; // stderr contained ggml_cuda_init (CUDA backend really offloaded)
  vectorOk: boolean; // a non-empty vector of EXPECTED_DIMS came back
  stderr: string;
}

export interface GpuProbeArgs {
  binaryPath: string;
  modelPath: string;
  libDir: string | null;
  ngl: number;
  platform: NodeJS.Platform;
}

export interface GpuPhaseOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injectable NVIDIA probe (defaults to embedder.hasNvidiaGpu). */
  detect?: () => Promise<boolean>;
  /** Injectable live-offload probe (defaults to a real llama-embedding run). */
  probe?: (args: GpuProbeArgs) => Promise<OffloadProbeResult>;
  binaryPath?: string;
  modelPath?: string;
}

export interface GpuPhaseResult {
  mode: 'gpu' | 'cpu';
  libDir: string | null;
  ngl: number;
  cudaAvailable: CudaAvailability;
  reason?: string;
}

/** Directory where a pre-built Linux CUDA stack may already live for reuse. */
export function binCudaDir(): string {
  return join(recallRoot(), 'bin-cuda');
}

/** Best-effort VRAM read via nvidia-smi. Returns undefined on any failure. */
async function readVram(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader'],
      { timeout: 5000, windowsHide: true },
    );
    const first = stdout.split('\n')[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect + classify the GPU for the current (or simulated) platform.
 * Pure reporting — no staging, no mutation. Feeds the manifest's GPU row and
 * the install-phase GPU decision.
 */
export async function detectGpu(opts: GpuPhaseOptions = {}): Promise<GpuInfo> {
  const p = opts.platform ?? osPlatform();
  const a = opts.arch ?? osArch();
  const detect = opts.detect ?? hasNvidiaGpu;
  const persistedMode = readConfig()?.embedder?.mode;

  // macOS arm64: Metal acceleration is in the standard llama.cpp build.
  if (p === 'darwin' && a === 'arm64') {
    return { detected: true, vendor: 'none', cudaAvailable: 'metal', plannedMode: 'gpu', persistedMode };
  }

  const hasGpu = await detect();
  if (!hasGpu) {
    return { detected: false, vendor: 'none', cudaAvailable: 'none', plannedMode: 'cpu', persistedMode };
  }

  const vram = await readVram();
  const base = { detected: true as const, vendor: 'nvidia', ...(vram ? { vram } : {}), persistedMode };

  if (p === 'win32' && a === 'x64') {
    // llama.cpp ships a prebuilt CUDA artifact for Windows; ensureBinary fetches
    // it (cuda candidate first) when a GPU is present, staging the libs adjacent.
    return { ...base, cudaAvailable: 'prebuilt', plannedMode: 'gpu' };
  }
  if (p === 'linux' && a === 'x64' && existsSync(binCudaDir())) {
    // Reuse a previously-built CUDA stack; no prebuilt Linux artifact exists.
    return { ...base, cudaAvailable: 'reuse-existing', plannedMode: 'gpu' };
  }
  // Linux x64 without a bin-cuda build, or any other arch: no usable CUDA libs.
  // Build-from-source is out of scope (see module header / §8).
  return { ...base, cudaAvailable: 'none', plannedMode: 'cpu' };
}

/** Real LIVE offload probe: run llama-embedding once with -ngl, capture stderr. */
async function defaultProbe(args: GpuProbeArgs): Promise<OffloadProbeResult> {
  const { binaryPath, modelPath, libDir, ngl, platform } = args;
  const adjacent = join(binaryPath, '..');
  const dirs = libDir ? [libDir, adjacent] : [adjacent];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [...dirs, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
  } else if (platform === 'win32') {
    env.PATH = [...dirs, process.env.PATH].filter(Boolean).join(';');
  } else {
    env.LD_LIBRARY_PATH = [...dirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }

  const probeArgs = [
    '-m', modelPath,
    '--embd-output-format', 'array',
    '-c', '8192',
    '--rope-scaling', 'yarn',
    '--rope-freq-scale', '0.75',
    '-ngl', String(ngl),
    '-p', 'recall gpu offload probe',
  ];

  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync(binaryPath, probeArgs, {
      env,
      timeout: OFFLOAD_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? e.message ?? '';
  }

  const cudaInit = /ggml_cuda_init/.test(stderr);
  let vectorOk = false;
  try {
    const parsed = JSON.parse(stdout.trim());
    vectorOk = Array.isArray(parsed) && Array.isArray(parsed[0]) && parsed[0].length === EXPECTED_DIMS;
  } catch { /* not parseable → vectorOk stays false */ }

  return { cudaInit, vectorOk, stderr };
}

/**
 * Run the MANDATORY GPU phase. Always resolves to a persisted verdict
 * (gpu-adopted OR cpu-fallback) — never throws on a GPU/offload failure.
 */
export async function runGpuPhase(opts: GpuPhaseOptions = {}): Promise<GpuPhaseResult> {
  const p = opts.platform ?? osPlatform();
  const info = await detectGpu(opts);
  const detectedAt = new Date().toISOString();

  const persist = (mode: 'gpu' | 'cpu', libDir: string | null, reason?: string): GpuPhaseResult => {
    writeEmbedderConfig({
      mode,
      ngl: mode === 'gpu' ? DEFAULT_NGL : 0,
      libDir,
      detectedAt,
      ...(reason ? { fallbackReason: reason } : {}),
    });
    if (reason) {
      log({ source: 'installer/gpu', level: 'info', summary: `GPU phase → CPU: ${reason}` });
    } else {
      log({ source: 'installer/gpu', level: 'info', summary: `GPU phase → ${mode} (cuda=${info.cudaAvailable}, libDir=${libDir ?? 'n/a'})` });
    }
    return { mode, libDir, ngl: mode === 'gpu' ? DEFAULT_NGL : 0, cudaAvailable: info.cudaAvailable, ...(reason ? { reason } : {}) };
  };

  // No usable GPU path: short-circuit to CPU, never stage, never probe.
  if (info.plannedMode === 'cpu') {
    const reason = info.detected && info.vendor === 'nvidia'
      ? 'NVIDIA GPU detected but no usable CUDA libs (no prebuilt for this platform; no ~/.recall/bin-cuda/ build present)'
      : undefined;
    return persist('cpu', null, reason);
  }

  // macOS Metal: accelerated in the standard build, no staging or live-test.
  if (info.cudaAvailable === 'metal') {
    return persist('gpu', null);
  }

  // Resolve the staged lib dir for the live test.
  const libDir = info.cudaAvailable === 'reuse-existing'
    ? binCudaDir()
    : info.cudaAvailable === 'prebuilt'
      ? binDir() // Windows: CUDA libs staged adjacent to the binary by ensureBinary
      : null;

  const probe = opts.probe ?? defaultProbe;
  const binaryPath = opts.binaryPath ?? getBinaryPath();
  const modelPath = opts.modelPath ?? getModelPath();

  try {
    const result = await probe({ binaryPath, modelPath, libDir, ngl: DEFAULT_NGL, platform: p });
    if (result.cudaInit && result.vectorOk) {
      return persist('gpu', libDir);
    }
    return persist('cpu', null, `live offload test failed (ggml_cuda_init=${result.cudaInit}, vector=${result.vectorOk})`);
  } catch (err) {
    return persist('cpu', null, `live offload test errored: ${(err as Error).message}`);
  }
}
