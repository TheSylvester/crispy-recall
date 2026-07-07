#!/usr/bin/env node
/**
 * Build the recall bundles. Emits:
 *   - dist/recall.js         (CLI entry point)
 *   - dist/stop-hook.js      (Claude Code / Codex Stop hook entry point)
 *   - dist/embed-pending.js  (detached child that drains unvectorized messages)
 *   - dist/statusline.js     (Claude Code statusLine command — lean, stdlib-only)
 * All bundles get a `#!/usr/bin/env node` shebang and 0755 perms.
 */

import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

mkdirSync(join(root, 'dist'), { recursive: true });

// Drop a stale wasm sidecar from a pre-migration build — dist/ is not cleaned
// between builds and the bundles now load better_sqlite3.node, not the wasm.
rmSync(join(root, 'dist/node-sqlite3-wasm.wasm'), { force: true });

const sharedOpts = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // No source maps in the published bundles — they add ~2.6 MB of dead weight
  // to the tarball and the CLI ships readable CJS.
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  external: [],
  loader: { '.md': 'text' },
};

await Promise.all([
  build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/cli/recall.ts')],
    outfile: join(root, 'dist/recall.js'),
  }),
  build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/hooks/stop-hook.ts')],
    outfile: join(root, 'dist/stop-hook.js'),
  }),
  build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/cli/embed-pending.ts')],
    outfile: join(root, 'dist/embed-pending.js'),
  }),
  build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/hooks/statusline.ts')],
    outfile: join(root, 'dist/statusline.js'),
  }),
]);

chmodSync(join(root, 'dist/recall.js'), 0o755);
chmodSync(join(root, 'dist/stop-hook.js'), 0o755);
chmodSync(join(root, 'dist/embed-pending.js'), 0o755);
chmodSync(join(root, 'dist/statusline.js'), 0o755);

// Copy the better-sqlite3 native addon alongside the bundle. The bundles load
// it via an explicit `nativeBinding: join(__dirname, 'better_sqlite3.node')`
// (db.ts), which is a runtime path — esbuild never sees a static `.node` import
// and needs no `.node` loader, so `external: []` and the plugin list stay
// unchanged. One copy serves all three bundles (they share dist/).
//
// NOTE (publish): this stages the *builder's* platform addon, which is correct
// for local build/test only. `package.json` `files` includes `dist/`, so a
// naive `npm publish` would ship this platform's `.node` to every user — the
// user-side restage in install.ts (resolved from the installer's own
// node_modules) is what keeps each machine ABI-correct. The publish phase must
// exclude dist/better_sqlite3.node from the tarball.
const nativeBinding = findNativeBinding(join(root, 'node_modules', 'better-sqlite3'));
if (nativeBinding) {
  copyFileSync(nativeBinding, join(root, 'dist/better_sqlite3.node'));
  console.log(`Staged native binding: ${nativeBinding} → dist/better_sqlite3.node`);
} else {
  console.warn(
    'Warning: could not locate better_sqlite3.node under node_modules/better-sqlite3 — ' +
      'run `npm install` (or `npm rebuild better-sqlite3`) so the bundle can load SQLite.',
  );
}

// Copy the recall SKILL.md template next to the bundle so the installer can
// resolve it at runtime regardless of how the package is laid out on disk.
try {
  copyFileSync(
    join(root, 'skill/SKILL.md.template'),
    join(root, 'dist/SKILL.md.template'),
  );
} catch (err) {
  console.warn(`Warning: failed to copy SKILL.md.template: ${err.message}`);
}

console.log('Built dist/recall.js, dist/stop-hook.js, dist/embed-pending.js, dist/statusline.js');

/**
 * Locate the compiled better-sqlite3 addon under its package dir. Prefers the
 * canonical gyp output, then falls back to a bounded recursive scan (covers
 * prebuild-install layouts like `prebuilds/…`). Does not hardcode a path.
 */
function findNativeBinding(baseDir) {
  const preferred = [
    join(baseDir, 'build', 'Release', 'better_sqlite3.node'),
    join(baseDir, 'build', 'Debug', 'better_sqlite3.node'),
  ];
  for (const c of preferred) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not there — keep looking
    }
  }
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.node')) return p;
    }
  }
  return null;
}
