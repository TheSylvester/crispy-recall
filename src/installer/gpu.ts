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
 *   - Linux x64 + NVIDIA → reuse an existing ~/.recall/bin/libggml-cuda.so if present
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
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { platform as osPlatform, arch as osArch, tmpdir } from 'node:os';
import { get as httpsGet } from 'node:https';
import extract from 'extract-zip';
import { hasNvidiaGpu, getBinaryPath, getModelPath } from '../recall/embedder.js';
import { binDir } from '../paths.js';
import { writeEmbedderConfig, readConfig } from './config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const EXPECTED_DIMS = 768;
const OFFLOAD_TIMEOUT_MS = 15_000;
const DEFAULT_NGL = 999;

/**
 * Our version-matched prebuilt Linux CUDA backend lib, built in CI
 * (.github/workflows/build-cuda-linux.yml) from llama.cpp at the SAME tag as the
 * CPU binary (b5300) so the ABI matches.
 *
 * The asset URL is PINNED to the package's own version tag
 * (`releases/download/v<version>/`) rather than `releases/latest/`. A pinned URL
 * is reproducible (a given recall version always fetches the asset built for it)
 * and never silently picks up a mismatched newer release. It 404s fast until the
 * matching release publishes the asset, at which point `downloadFile` succeeds;
 * a 404 before then simply falls back to CPU (which is correct and safe).
 */
const CUDA_ASSET_NAME = 'recall-libggml-cuda-linux-x64-b5300.zip';

/** Resolve owner/repo + version from package.json so the asset URL stays pinned. */
function cudaAssetUrl(): string {
  let owner = 'TheSylvester';
  let repo = 'crispy-recall';
  let version = '';
  try {
    // gpu.ts is bundled into dist/recall.js (cjs), so __dirname is dist/ and the
    // package.json sits one level up (same lookup as cli/recall.ts getVersion).
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string;
      repository?: { url?: string } | string;
    };
    version = typeof pkg.version === 'string' ? pkg.version : '';
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const m = repoUrl?.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (m) {
      owner = m[1];
      repo = m[2];
    }
  } catch {
    /* fall back to hardcoded owner/repo; version stays '' → unpinned-but-tagged */
  }
  const tag = version ? `download/v${version}` : 'latest/download';
  return `https://github.com/${owner}/${repo}/releases/${tag}/${CUDA_ASSET_NAME}`;
}

const CUDA_ASSET_URL = cudaAssetUrl();
const STAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

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
  cudaInit: boolean; // stderr proved the CUDA backend really offloaded (see stderrIndicatesOffload)
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

/** Args handed to the Linux 'prebuilt' staging step. */
export interface StageArgs {
  platform: NodeJS.Platform;
  arch: string;
  offline: boolean;
}

export interface GpuPhaseOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injectable NVIDIA probe (defaults to embedder.hasNvidiaGpu). */
  detect?: () => Promise<boolean>;
  /** Injectable live-offload probe (defaults to a real llama-embedding run). */
  probe?: (args: GpuProbeArgs) => Promise<OffloadProbeResult>;
  /** Injectable Linux 'prebuilt' staging (defaults to fetch + extract our CUDA asset). */
  stage?: (args: StageArgs) => Promise<string | null>;
  /** Offline: never hit the network during staging — only use pre-staged libs. */
  offline?: boolean;
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

/**
 * Path to the staged CUDA backend lib. It MUST sit next to the executable and
 * the other libggml-*.so files (i.e. in bin/), because llama.cpp's
 * GGML_BACKEND_DL loader discovers backends by scanning the binary's own
 * directory — it does NOT consult LD_LIBRARY_PATH for backend discovery.
 * Staging it in a separate dir leaves the CUDA backend unloaded and silently
 * falls back to CPU (while still printing "offloaded N/N layers to GPU").
 * This matches the Windows path, which already co-locates its CUDA libs in bin/.
 */
export function cudaBackendLib(): string {
  return join(binDir(), 'libggml-cuda.so');
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
  if (p === 'linux' && a === 'x64' && existsSync(cudaBackendLib())) {
    // Reuse a previously staged CUDA backend lib — the higher-priority shortcut.
    return { ...base, cudaAvailable: 'reuse-existing', plannedMode: 'gpu' };
  }
  if (p === 'linux' && a === 'x64') {
    // No local build → fetch our version-matched prebuilt libggml-cuda.so
    // (build-cuda-linux.yml). The live offload test still gates adoption; a
    // missing asset / offline / failed offload silently falls back to CPU.
    // (Build-from-source is still out of scope — this is a fetch, not a compile.)
    return { ...base, cudaAvailable: 'prebuilt', plannedMode: 'gpu' };
  }
  // Any other arch (e.g. linux arm64): no usable CUDA libs.
  return { ...base, cudaAvailable: 'none', plannedMode: 'cpu' };
}

/**
 * Decide whether a probe's stderr proves the CUDA backend actually loaded and
 * ran on the GPU. The ONLY reliable signals are ones the CUDA backend itself
 * emits when it initializes a device and allocates device buffers:
 *   - "ggml_cuda_init: found N CUDA devices"
 *   - "load_backend: loaded CUDA backend from .../libggml-cuda.so"
 *   - "using device CUDA0 (...)"
 *   - "CUDA0 {model,compute,KV} buffer size = ..."
 *
 * The "offloaded N/N layers to GPU" line is NOT reliable: llama.cpp prints it
 * from the requested -ngl even when the CUDA backend failed to load and every
 * tensor silently stayed on the CPU (the buffers then show as "CPU_Mapped" /
 * "CPU compute buffer"). Keying on it caused the installer to adopt GPU and
 * persist mode=gpu while embedding actually ran on the CPU — slow enough to look
 * like a stalled backfill. Require a real device/backend marker instead.
 */
export function stderrIndicatesOffload(stderr: string): boolean {
  return /ggml_cuda_init|found\s+\d+\s+CUDA\s+devices|loaded CUDA backend|using device CUDA|CUDA0[^\n]*buffer/i.test(stderr);
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
    // Probe with the SAME flags the real embed server uses (esp. -fa). Without
    // Flash Attention the probe allocates the ~3.7 GB O(n²) attention buffer and
    // OOMs on a 4 GB card — failing the probe and falling back to CPU even
    // though the actual -fa server (~2.9 GB) would have fit. Probe must mirror
    // runtime to gate GPU adoption correctly.
    '-fa',
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

  const cudaInit = stderrIndicatesOffload(stderr);
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
      ? 'NVIDIA GPU detected but no usable CUDA libs (no prebuilt for this platform; no ~/.recall/bin/libggml-cuda.so present)'
      : undefined;
    return persist('cpu', null, reason);
  }

  // macOS Metal: accelerated in the standard build, no staging or live-test.
  if (info.cudaAvailable === 'metal') {
    return persist('gpu', null);
  }

  // Resolve the staged lib dir for the live test.
  let libDir: string | null;
  if (info.cudaAvailable === 'reuse-existing') {
    libDir = binDir();
  } else if (info.cudaAvailable === 'prebuilt' && p === 'win32') {
    // Windows: the prebuilt CUDA libs are staged adjacent to the binary by
    // embedder.ensureBinary (cuda candidate first when a GPU is present).
    libDir = binDir();
  } else if (info.cudaAvailable === 'prebuilt') {
    // Linux: fetch + extract our version-matched libggml-cuda.so before testing.
    const stage = opts.stage ?? defaultStage;
    libDir = await stage({ platform: p, arch: opts.arch ?? osArch(), offline: opts.offline ?? false });
    if (!libDir) {
      return persist(
        'cpu',
        null,
        'GPU unavailable: could not stage the prebuilt CUDA backend (offline, or the version-matched ' +
          `${CUDA_ASSET_NAME} is not yet published for this release / download failed). ` +
          'GPU offload requires BOTH the published prebuilt asset AND a system CUDA runtime (libcudart/libcublas).',
      );
    }
  } else {
    libDir = null;
  }

  const probe = opts.probe ?? defaultProbe;
  const binaryPath = opts.binaryPath ?? getBinaryPath();
  const modelPath = opts.modelPath ?? getModelPath();

  try {
    const result = await probe({ binaryPath, modelPath, libDir, ngl: DEFAULT_NGL, platform: p });
    if (result.cudaInit && result.vectorOk) {
      return persist('gpu', libDir);
    }
    const cudaRuntimeHint =
      p === 'linux' && info.cudaAvailable === 'prebuilt'
        ? ' — the prebuilt libggml-cuda.so staged but offload failed; this host likely lacks the system CUDA runtime (libcudart/libcublas), which the NVIDIA driver alone does not provide'
        : '';
    return persist(
      'cpu',
      null,
      `live offload test failed (ggml_cuda_init=${result.cudaInit}, vector=${result.vectorOk})${cudaRuntimeHint}`,
    );
  } catch (err) {
    return persist('cpu', null, `live offload test errored: ${(err as Error).message}`);
  }
}

/**
 * Default Linux 'prebuilt' staging: ensure `libggml-cuda.so` is present in
 * ~/.recall/bin/ — next to the executable + other libggml-*.so, where the
 * backend loader can find it (see cudaBackendLib). Staging there means a future
 * install's 'reuse-existing' shortcut picks it up. Returns the bin dir, or null
 * on any failure / offline-absent.
 *
 * cudart/cublas are NOT fetched here — they are validated by the subsequent LIVE
 * offload probe (a CUDA host normally has them system-wide). A host missing the
 * CUDA runtime simply fails the probe and falls back to CPU, which is correct.
 */
async function defaultStage(args: StageArgs): Promise<string | null> {
  const target = binDir();
  const libPath = cudaBackendLib();
  if (existsSync(libPath)) return target; // already staged (prior install or offline pre-stage)
  if (args.offline) return null;          // offline + absent: no network, fall back to CPU

  try {
    mkdirSync(target, { recursive: true });
    const zipPath = join(tmpdir(), CUDA_ASSET_NAME);
    await downloadFile(CUDA_ASSET_URL, zipPath);
    await extract(zipPath, { dir: target });
    return existsSync(libPath) ? target : null;
  } catch (err) {
    log({ source: 'installer/gpu', level: 'info', summary: `prebuilt CUDA staging failed: ${(err as Error).message}` });
    return null;
  }
}

/** Minimal URL→file download, following redirects (GitHub release pattern). */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('download timeout')), STAGE_DOWNLOAD_TIMEOUT_MS);
    const done = (err?: Error) => { clearTimeout(to); err ? reject(err) : resolve(); };
    const pipeTo = (res: import('node:http').IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        httpsGet(res.headers.location, { headers: { 'User-Agent': 'recall' } }, pipeTo).on('error', done);
        return;
      }
      if (status !== 200) { done(new Error(`HTTP ${status}`)); return; }
      const file = createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => done()));
      file.on('error', done);
    };
    httpsGet(url, { headers: { 'User-Agent': 'recall' } }, pipeTo).on('error', done);
  });
}
