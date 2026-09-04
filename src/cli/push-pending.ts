/**
 * push-pending — the fifth staged bundle (spec §3.3).
 *
 * A thin argv wrapper around `runPush`. The satellite Stop hook spawns it
 * detached with `--named/--hook/--cwd`; the installer spawns it once with
 * `--full`; the CLI's inline flush calls `runPush` in-process instead.
 *
 * Discipline: this process MUST exit 0. It runs detached behind a finished
 * turn — a non-zero exit or a stack trace helps nobody and a failure is
 * already recorded in `~/.recall/logs/push.log`.
 *
 * @module cli/push-pending
 */

import { runPush, type PushHookMeta } from '../satellite/push.js';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function parsePushArgv(argv: string[]): Parameters<typeof runPush>[0] {
  const named = flagValue(argv, '--named');
  const cwd = flagValue(argv, '--cwd');
  const rawHook = flagValue(argv, '--hook');
  let hook: PushHookMeta | undefined;
  if (rawHook) {
    try {
      const parsed = JSON.parse(rawHook) as PushHookMeta;
      if (parsed && typeof parsed === 'object' && typeof parsed.isSubagent === 'boolean') hook = parsed;
    } catch { /* an unparseable hook blob is not worth failing a push over */ }
  }
  return {
    ...(named ? { named } : {}),
    ...(cwd ? { cwd } : {}),
    ...(hook ? { hook } : {}),
    ...(argv.includes('--full') ? { full: true } : {}),
  };
}

async function main(): Promise<void> {
  try {
    await runPush(parsePushArgv(process.argv.slice(2)));
  } catch { /* runPush already logged it; never throw out of a detached child */ }
  process.exit(0);
}

declare const require: NodeJS.Require | undefined;
declare const module: NodeJS.Module | undefined;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main();
}
