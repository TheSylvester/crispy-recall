/**
 * defaultDistDir — bundle source resolution for `stageBundles`.
 *
 * Regression: under a global npm install `recall` is a symlink in bin/
 * (bin/recall → ../lib/node_modules/crispy-recall/dist/recall.js). argv[1] is
 * the symlink path, so dirname(argv[1]) yields bin/ — where the bundles do NOT
 * live — and staging silently no-ops, leaving the wired Stop hook pointing at a
 * missing stop-hook.js. defaultDistDir must realpath argv[1] to reach dist/.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultDistDir } from '../../src/installer/install.js';

let sandbox: string | undefined;
const prevArgv1 = process.argv[1];

afterEach(() => {
  process.argv[1] = prevArgv1;
  if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = undefined; }
});

describe('defaultDistDir', () => {
  it('resolves a symlinked bin entry to the real dist dir', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'recall-distdir-'));
    const dist = join(sandbox, 'lib', 'node_modules', 'crispy-recall', 'dist');
    const bin = join(sandbox, 'bin');
    mkdirSync(dist, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const realEntry = join(dist, 'recall.js');
    writeFileSync(realEntry, '// bundle\n');
    const link = join(bin, 'recall');
    symlinkSync(realEntry, link);

    process.argv[1] = link;
    // Must be the dist dir (where stop-hook.js lives), NOT bin/.
    expect(defaultDistDir()).toBe(dist);
  });

  it('returns the containing dir for a non-symlinked entry', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'recall-distdir-'));
    const dist = join(sandbox, 'dist');
    mkdirSync(dist, { recursive: true });
    const entry = join(dist, 'recall.js');
    writeFileSync(entry, '// bundle\n');

    process.argv[1] = entry;
    expect(defaultDistDir()).toBe(dist);
  });
});
