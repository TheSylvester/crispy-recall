/**
 * probeStagedBinding — defect 4 (verify a staged sqlite binding before trusting it).
 *
 * The installer load-probes the freshly-staged better_sqlite3.node in a
 * short-lived child before writing the ABI marker. A real addon must probe OK;
 * a garbage / wrong-arch file must probe as a load failure (so the installer
 * aborts with the two-node message instead of writing a marker that vouches for
 * a binding that cannot dlopen). Child-process isolation is what keeps repeated
 * probes from crashing the host process on teardown.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { probeStagedBinding } from '../../src/installer/install.js';

let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = undefined; }
});

/** Locate the real better-sqlite3 addon in this repo's node_modules. */
function realBinding(): string {
  const pkg = require.resolve('better-sqlite3/package.json');
  return join(dirname(pkg), 'build', 'Release', 'better_sqlite3.node');
}

describe('probeStagedBinding', () => {
  it('reports ok for a real, ABI-matching better_sqlite3.node', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'recall-probe-'));
    const dest = join(sandbox, 'better_sqlite3.node');
    copyFileSync(realBinding(), dest);
    expect(probeStagedBinding(dest)).toEqual({ ok: true });
  });

  it('reports a load failure for a garbage .node file', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'recall-probe-'));
    const dest = join(sandbox, 'better_sqlite3.node');
    writeFileSync(dest, 'this is not a native addon');
    const res = probeStagedBinding(dest);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.length).toBeGreaterThan(0);
  });

  it('reports a load failure for a missing binding path', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'recall-probe-'));
    const res = probeStagedBinding(join(sandbox, 'nonexistent.node'));
    expect(res.ok).toBe(false);
  });
});
