/**
 * The package version, as every bundle sees it (spec §6).
 *
 * `scripts/build.mjs` replaces `__RECALL_VERSION__` with the literal
 * `package.json` version at build time, so a STAGED bundle under `~/.recall/bin`
 * — which has no sibling `package.json` — reports the real version instead of
 * `unknown`. Under `tsx`/vitest there is no define, so the reader falls back to
 * the package.json beside (or one level above) the module.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

declare const __RECALL_VERSION__: string | undefined;

/** Package version, or `unknown` when neither the define nor a package.json is available. */
export function getVersion(): string {
  if (typeof __RECALL_VERSION__ === 'string' && __RECALL_VERSION__.length > 0) {
    return __RECALL_VERSION__;
  }
  try {
    // Two candidates: `src/version.ts` is one level under the root, and a
    // compiled/bundled copy may sit one level deeper again.
    const candidates = [
      join(__dirname, '..', 'package.json'),
      join(__dirname, '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      // Guard: a stray sibling package.json must not win.
      if (pkg.name === 'crispy-recall' && pkg.version) return pkg.version;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}
