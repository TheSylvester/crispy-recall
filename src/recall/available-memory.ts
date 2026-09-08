import { execFileSync } from 'node:child_process';
import { freemem, platform } from 'node:os';

const CACHE_MS = 1000;
let cached: { at: number; bytes: number } | undefined;

/** Match libuv's Darwin available-memory heuristic, including reclaimable
 * pages: https://github.com/libuv/libuv/commit/a944c422cca5522073e03710ca7fd08f53218358
 * Older Node releases expose only free pages through both os.freemem() and
 * process.availableMemory(), which can stall backfill on a healthy Mac. */
export function parseDarwinAvailableMemory(output: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const counts = ['free', 'inactive', 'purgeable'].map((kind) =>
    Number(new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.\\s*$`, 'm').exec(output)?.[1]));
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || counts.some((n) => !Number.isSafeInteger(n) || n < 0)) return undefined;
  const bytes = counts.reduce((a, b) => a + b, 0) * pageSize;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

/** Available bytes for the backfill guard. Keep non-Darwin behavior unchanged;
 * a failed Darwin probe falls back conservatively to current free memory. */
export function availableMemory(): number {
  const free = freemem();
  if (platform() !== 'darwin') return free;
  const now = Date.now();
  if (!cached || now < cached.at || now - cached.at >= CACHE_MS) {
    let bytes = 0;
    try {
      bytes = parseDarwinAvailableMemory(execFileSync('/usr/bin/vm_stat', {
        encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024,
      })) ?? 0;
    } catch { /* Missing command, timeout or unreadable output: keep the guard. */ }
    cached = { at: now, bytes };
  }
  return Math.max(free, cached.bytes);
}
