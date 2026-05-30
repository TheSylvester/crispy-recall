/**
 * Stop Hook — Claude Code / Codex Stop event entry point.
 *
 * Reads the Stop payload from stdin, dispatches vendor on transcript_path,
 * and ingests the just-finished session's messages into the FTS5 index.
 *
 * Discipline: this hook MUST exit 0. Exit 2 blocks the agent from stopping
 * (recall failure must never block the user's turn). Any error is logged
 * to ~/.recall/logs/stop-hook.log and swallowed.
 *
 * @module hooks/stop-hook
 */
import { ingestSessionMessages } from "../recall/message-ingest.js";
import { getDb } from "../db.js";
import { binDir, dbPath, logsDir } from "../paths.js";
import { appendFileSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";

/**
 * Decide the vendor from a transcript path.
 *
 * Normalizes separators to forward slashes first so the `/.codex/` substring
 * test works regardless of native separator — on Windows-native the harness
 * supplies backslash paths (`C:\Users\..\.codex\sessions\..`), which would
 * otherwise misroute every Codex session to the Claude adapter. Mirrors the
 * normalization in src/url-path-resolver.ts.
 */
export function vendorForTranscript(transcriptPath: string): 'claude' | 'codex' {
  const p = transcriptPath.replace(/\\/g, '/');
  return p.includes("/.codex/") ? "codex" : "claude";
}

/** Append a line to the stop-hook log, swallowing any error (must never throw). */
function logStopHook(line: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(join(logsDir(), "stop-hook.log"), line);
  } catch {} // never let logging throw — must exit 0
}

async function runStopHook(): Promise<void> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  let payload: { session_id?: string; transcript_path?: string; cwd?: string; stop_hook_active?: boolean };
  try { payload = JSON.parse(data); } catch { process.exit(0); }
  if (!payload?.session_id || !payload?.transcript_path) process.exit(0);
  if (payload.stop_hook_active) process.exit(0); // recursion guard

  try {
    // 500 ms busy_timeout for hook DB writes — multi-process contention defers
    // to T1 mtime-scan rather than blocking Claude Code on the writer lock.
    // (Other recall connections keep the 5000 ms default set in db.ts.) Inside
    // the try so a DB open/init failure is logged and swallowed — the hook must
    // always exit 0 and never block the user's turn.
    getDb(dbPath()).exec("PRAGMA busy_timeout = 500;");

    const vendor = vendorForTranscript(payload.transcript_path);

    const result = await ingestSessionMessages(
      payload.session_id,
      payload.transcript_path,
      vendor,
      { projectId: payload.cwd ?? undefined },
    );
    // ingestSessionMessages reports soft failures via { error } rather than
    // throwing — log those too, else they vanish silently.
    if (result?.error) {
      logStopHook(
        `${new Date().toISOString()} ingest-failed sid=${payload.session_id} err=${result.error}\n`,
      );
    }
  } catch (e) {
    logStopHook(
      `${new Date().toISOString()} ingest-failed sid=${payload.session_id} err=${(e as Error).message}\n`,
    );
  }

  // Detach an embed-pending child to vectorize anything still missing.
  // The lockfile inside the child guarantees at most one llama-server runs
  // across the host; siblings exit 0 silently when the lock is held.
  spawn(
    process.execPath,
    [join(binDir(), "embed-pending.js"), payload.session_id],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  ).unref();

  process.exit(0);
}

// Only consume stdin / exit when invoked as the Stop hook entry point. When the
// module is imported (e.g. unit tests for vendorForTranscript), the IIFE must
// NOT run — otherwise it would block on stdin and call process.exit. In the
// esbuild CJS bundle `require.main === module` is true only for the direct
// `node dist/stop-hook.js` invocation.
declare const require: NodeJS.Require | undefined;
declare const module: NodeJS.Module | undefined;
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void runStopHook();
}
