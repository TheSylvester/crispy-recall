/**
 * The npm `files` allowlist IS the packaging contract: it must select exactly
 * the six dist artifacts (five bundles + SKILL.md.template) plus the docs npm
 * always includes, and it must leave the builder's dist/better_sqlite3.node
 * out WITHOUT any lifecycle script deleting it from the working tree.
 *
 * `npm pack --dry-run --json --ignore-scripts` resolves the allowlist against
 * the real working tree without building, writing a tarball, or running
 * prepack — so this can run beside the rest of the suite (vitest runs files in
 * parallel; a real pack would rebuild dist/ under other workers' feet). CI runs
 * the real `npm pack` and the same checker on the produced tarball.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(__dirname, '..', '..');
const binding = join(repoRoot, 'dist', 'better_sqlite3.node');

let checkTarballEntries: (entries: string[]) => { ok: boolean; report: string; forbidden: string[] };

beforeAll(async () => {
  const url = pathToFileURL(join(repoRoot, 'scripts/ci/assert-tarball.mjs')).href;
  ({ checkTarballEntries } = (await import(/* @vite-ignore */ url)) as { checkTarballEntries: typeof checkTarballEntries });
});

describe('package.json files allowlist', () => {
  it('names the six dist artifacts explicitly and no dist/ glob; no lifecycle script deletes the binding', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      files: string[]; scripts: Record<string, string>;
    };
    expect(pkg.files).toEqual(expect.arrayContaining([
      'dist/recall.js', 'dist/stop-hook.js', 'dist/embed-pending.js',
      'dist/statusline.js', 'dist/push-pending.js', 'dist/SKILL.md.template',
    ]));
    expect(pkg.files.some((f) => /^dist\/?$/.test(f) || f.includes('*'))).toBe(false);
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, `scripts.${name} must not delete the working-tree binding`).not.toMatch(/rm .*better_sqlite3\.node/);
    }
    expect(pkg.scripts).not.toHaveProperty('postpack');
  });

  it('resolves to exactly the published file set, excluding the staged binding while it stays on disk', () => {
    // pretest built dist/, so the binding is present when the suite runs.
    expect(existsSync(binding)).toBe(true);
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const entries = pack!.files.map((f) => `package/${f.path}`);
    const r = checkTarballEntries(entries);
    expect(r.forbidden).toEqual([]);
    expect(r.ok, r.report).toBe(true);
    // Packing (even for real) must never touch the working tree's binding.
    expect(existsSync(binding)).toBe(true);
  });
});
