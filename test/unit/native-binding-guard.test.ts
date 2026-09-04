/**
 * One process, one `better_sqlite3.node` (R-01y2w6).
 *
 * The installer opens second raw handles beside `getDb`'s shared connection.
 * When those resolve a DIFFERENT `.node` file, the process dlopens two copies
 * of SQLite with independent unix-VFS state, and a `close()` in either copy
 * drops the PROCESS's POSIX locks on that inode — including the shared DMS
 * lock the live connection depends on. That is how the installer lost its lock
 * while keeping its wal-index map and took SIGBUS when the detached drain
 * child reset the index.
 *
 * Both openers must therefore route through `db.ts resolveNativeBindingPath`.
 * A runtime assertion would need two real layouts, so this guard reads the
 * source and fails if the old `join(binDir(), 'better_sqlite3.node')` literal
 * comes back.
 *
 * This suite opens no database and spawns no child. Tests never touch the live
 * root. `_setTestRoot` does not cross a process boundary: every new suite that
 * spawns a child (hub daemon, `dist/recall.js`, `stop-hook.js`,
 * `push-pending.js`, `embed-pending.js`) MUST pass an explicit
 * `env: { ...process.env, RECALL_HOME: <tmp>, RECALL_REMOTE_ROOT: <tmp>/remote,
 * CLAUDE_CONFIG_DIR: <tmp>/claude, CODEX_HOME: <tmp>/codex }`; a child that
 * inherits the parent env resolves `recallRoot()` to the live `~/.recall`
 * (paths.ts:35-40).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

const OPENERS = [
  join(SRC, 'installer', 'upgrade-migrate.ts'),
  join(SRC, 'installer', 'retrieval-class-migration.ts'),
];

describe('native binding: one resolver for every opener', () => {
  it.each(OPENERS)('%s resolves through resolveNativeBindingPath', (file) => {
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('resolveNativeBindingPath');
  });

  it.each(OPENERS)('%s never resolves the staged addon on its own', (file) => {
    const offending = readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .filter((line) => line.includes('binDir()') && line.includes('better_sqlite3.node'));
    expect(offending, `re-resolving the addon here loads a SECOND SQLite: ${offending.join(' | ')}`)
      .toEqual([]);
  });

  it('db.ts exports the single resolver the openers import', () => {
    const src = readFileSync(join(SRC, 'db.ts'), 'utf-8');
    expect(src).toMatch(/export function resolveNativeBindingPath\(\): string \| null/);
  });
});
