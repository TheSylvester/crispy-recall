#!/usr/bin/env node
/**
 * Build the recall bundles. Emits:
 *   - dist/recall.js         (CLI entry point)
 *   - dist/stop-hook.js      (Claude Code / Codex Stop hook entry point)
 *   - dist/embed-pending.js  (detached child that drains unvectorized messages)
 * All bundles get a `#!/usr/bin/env node` shebang and 0755 perms.
 */

import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

mkdirSync(join(root, 'dist'), { recursive: true });

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
]);

chmodSync(join(root, 'dist/recall.js'), 0o755);
chmodSync(join(root, 'dist/stop-hook.js'), 0o755);
chmodSync(join(root, 'dist/embed-pending.js'), 0o755);

// Copy node-sqlite3-wasm runtime alongside the bundle (relative path lookup).
try {
  copyFileSync(
    join(root, 'node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm'),
    join(root, 'dist/node-sqlite3-wasm.wasm'),
  );
} catch (err) {
  console.warn(`Warning: failed to copy node-sqlite3-wasm runtime: ${err.message}`);
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

console.log('Built dist/recall.js, dist/stop-hook.js, dist/embed-pending.js');
