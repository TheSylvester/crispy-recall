/**
 * statusline — the dedicated Claude Code statusLine command bundle.
 *
 * Emitted as dist/statusline.js and wired into ~/.claude/settings.json as
 *   "statusLine": { "type": "command", "command": "<node> <.recall/bin/statusline.js>" }
 * when (and only when) the user opts in AND has no existing status line.
 *
 * Claude Code pipes its status JSON to this command's stdin on each refresh and
 * renders stdout. This MUST be a LEAN bundle — it imports nothing beyond
 * node:process + the leaf renderer, so launching it costs no db/embedder eval
 * (the status line runs up to ~once/second under a <100ms budget). NEVER wire
 * `node recall.js statusline`: the full CLI statically imports db/embedder.
 *
 * Discipline: read stdin fully, tolerate a bad/empty payload (empty object),
 * print the standalone line, and always exit 0.
 *
 * @module hooks/statusline
 */
import process from 'node:process';
import { renderStandaloneStatusline, type StatuslineInput } from '../recall/statusline-segment.js';

async function runStatusline(): Promise<void> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  let json: StatuslineInput;
  try {
    json = JSON.parse(data) as StatuslineInput;
  } catch {
    json = {};
  }
  process.stdout.write(renderStandaloneStatusline(json ?? {}));
  process.exit(0);
}

// Only consume stdin / exit when invoked as the statusline entry point. When the
// module is imported (unit tests), the IIFE must NOT run — otherwise it blocks
// on stdin and calls process.exit. In the esbuild CJS bundle
// `require.main === module` is true only for the direct `node statusline.js`.
declare const require: NodeJS.Require | undefined;
declare const module: NodeJS.Module | undefined;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runStatusline();
}
