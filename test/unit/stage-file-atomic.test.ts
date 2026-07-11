/**
 * stageFileAtomic — regression for the 0.3.0 upgrade segfault.
 *
 * classifyUpgrade() maps the staged better_sqlite3.node into the installer
 * process (openReadonly's staged-binding-first resolution); staging then
 * rewrote that same file with an in-place copyFileSync. The O_TRUNC discards
 * the live mapping's relocated (dirty COW) pages — Linux truncate zaps private
 * COW pages too — so they re-fault as raw unrelocated file bytes, and the next
 * GC weak-callback jumps through a pristine GOT slot: deterministic SIGSEGV
 * mid-install. The fix stages via a sibling temp file + rename, which swaps
 * only the directory entry and never touches the mapped inode.
 *
 * Observable invariants asserted here: replacing content NEVER reuses the
 * destination inode (i.e. never truncates in place), identical content is left
 * completely untouched, and no temp files are left behind.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageFileAtomic } from '../../src/installer/install.js';

// Passthrough node:fs mock whose renameSync can be armed to fail — the only
// way to reach the Windows fallback (and its rollback) from a POSIX test box.
const renameGate = vi.hoisted(() => ({
  interceptor: undefined as ((from: string, to: string) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renameGate.interceptor?.(from, to);
      return actual.renameSync(from, to);
    },
  };
});

let sandbox: string | undefined;

afterEach(() => {
  renameGate.interceptor = undefined;
  if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = undefined; }
});

function setup(): { src: string; dest: string } {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-stage-'));
  return { src: join(sandbox, 'src.node'), dest: join(sandbox, 'dest.node') };
}

const ino = (p: string) => statSync(p, { bigint: true }).ino;

describe('stageFileAtomic', () => {
  it('creates a missing destination and leaves no temp files', () => {
    const { src, dest } = setup();
    writeFileSync(src, 'v1');
    stageFileAtomic(src, dest);
    expect(readFileSync(dest, 'utf-8')).toBe('v1');
    expect(readdirSync(sandbox!).sort()).toEqual(['dest.node', 'src.node']);
  });

  it('replaces different content via a NEW inode — never an in-place truncate', () => {
    const { src, dest } = setup();
    writeFileSync(dest, 'old-binding-bytes');
    const before = ino(dest);
    writeFileSync(src, 'new-binding-bytes');
    stageFileAtomic(src, dest);
    expect(readFileSync(dest, 'utf-8')).toBe('new-binding-bytes');
    // A truncate+rewrite would keep the inode; rename must swap to a new one,
    // so a process that mmapped the old file keeps its relocated pages intact.
    expect(ino(dest)).not.toBe(before);
    expect(readdirSync(sandbox!).sort()).toEqual(['dest.node', 'src.node']);
  });

  it('leaves a byte-identical destination completely untouched', () => {
    const { src, dest } = setup();
    writeFileSync(dest, 'same-bytes');
    const before = ino(dest);
    writeFileSync(src, 'same-bytes');
    stageFileAtomic(src, dest);
    expect(ino(dest)).toBe(before);
    expect(readdirSync(sandbox!).sort()).toEqual(['dest.node', 'src.node']);
  });

  it.skipIf(process.platform === 'win32')('preserves the source file mode on the staged copy', () => {
    const { src, dest } = setup();
    writeFileSync(src, '#!node');
    chmodSync(src, 0o755); // writeFileSync's mode option is umask-masked; chmod pins it exactly
    stageFileAtomic(src, dest);
    expect(statSync(dest).mode & 0o777).toBe(0o755);
  });

  it('rolls the set-aside back to dest when the fallback rename also fails', () => {
    const { src, dest } = setup();
    writeFileSync(dest, 'old-binding-bytes');
    writeFileSync(src, 'new-binding-bytes');
    // Simulate a scanner holding the freshly written temp (the common Windows
    // AV flake): every rename OF the .staging file fails, others pass through.
    // First tmp→dest fails, dest→.old succeeds, retry tmp→dest fails again.
    renameGate.interceptor = (from) => {
      if (from.includes('.staging-')) {
        throw Object.assign(new Error('EPERM: file held by scanner'), { code: 'EPERM' });
      }
    };
    expect(() => stageFileAtomic(src, dest)).toThrow(/EPERM/);
    // The previous file must be restored at its canonical path — a missing
    // better_sqlite3.node would kill every hook fire until a re-install —
    // and neither the temp nor the .old set-aside may be left behind.
    expect(readFileSync(dest, 'utf-8')).toBe('old-binding-bytes');
    expect(readdirSync(sandbox!).sort()).toEqual(['dest.node', 'src.node']);
  });
});
