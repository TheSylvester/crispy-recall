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

(async () => {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  let payload: { session_id?: string; transcript_path?: string; cwd?: string; stop_hook_active?: boolean };
  try { payload = JSON.parse(data); } catch { process.exit(0); }
  if (!payload?.session_id || !payload?.transcript_path) process.exit(0);
  if (payload.stop_hook_active) process.exit(0); // recursion guard

  // 500 ms busy_timeout for hook DB writes — multi-process contention defers
  // to T1 mtime-scan rather than blocking Claude Code on the writer lock.
  // (Other recall connections keep the 5000 ms default set in db.ts.)
  getDb(dbPath()).exec("PRAGMA busy_timeout = 500;");

  const vendor: 'claude' | 'codex' =
    payload.transcript_path.includes("/.codex/") ? "codex" : "claude";

  try {
    await ingestSessionMessages(
      payload.session_id,
      payload.transcript_path,
      vendor,
      { projectId: payload.cwd ?? undefined },
    );
  } catch (e) {
    try {
      mkdirSync(logsDir(), { recursive: true });
      appendFileSync(
        join(logsDir(), "stop-hook.log"),
        `${new Date().toISOString()} ingest-failed sid=${payload.session_id} err=${(e as Error).message}\n`,
      );
    } catch {} // never let logging throw — must exit 0
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
})();
