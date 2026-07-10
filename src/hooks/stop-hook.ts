/**
 * Stop Hook — Claude Code / Codex Stop event entry point.
 *
 * Reads the Stop payload from stdin, resolves the finished transcript (including
 * Codex's separate SubagentStop transcript), and ingests its messages into the
 * FTS5 index.
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
export function vendorForTranscript(
  transcriptPath: string,
  codexHome = process.env['CODEX_HOME'],
): 'claude' | 'codex' {
  const p = transcriptPath.replace(/\\/g, '/');
  const root = codexHome?.replace(/\\/g, '/').replace(/\/$/, '');
  const underCodexHome = root ? p === root || p.startsWith(`${root}/`) : false;
  return p.includes("/.codex/") || underCodexHome ? "codex" : "claude";
}

export interface StopHookPayload {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  stop_hook_active?: boolean;
  agent_id?: string;
  agent_transcript_path?: string | null;
}

export interface IngestTarget {
  /** Session-id HINT only — canonical identity is resolved by the session
   *  classifier from the transcript's own session-meta/basename/provenance. */
  sessionId: string;
  transcriptPath: string;
  /** Classification evidence forwarded into the ingest. */
  hook: {
    payloadSessionId?: string;
    agentId?: string;
    isSubagent: boolean;
  };
}

/**
 * Resolve what to ingest from a Stop/SubagentStop payload.
 *
 * When `agent_transcript_path` is present the CHILD transcript is the target
 * and `payload.session_id` is the PARENT — it must NEVER be used as the
 * child's session id (the old code did exactly that when `agent_id` was
 * absent, stapling child messages onto the parent). The hint here is the
 * child transcript's basename; the classifier derives the canonical id from
 * the child's own session-meta (Codex) or agent-* name (Claude), and records
 * `agent_id` as an alias when it differs.
 */
export function resolveIngestTarget(payload: StopHookPayload): IngestTarget | null {
  if (payload.agent_transcript_path) {
    const transcriptPath = payload.agent_transcript_path;
    const base = transcriptPath.replace(/\\/g, '/').split('/').pop()!.replace(/\.jsonl$/i, '');
    if (!base) return null;
    return {
      sessionId: base,
      transcriptPath,
      hook: {
        ...(payload.session_id ? { payloadSessionId: payload.session_id } : {}),
        ...(payload.agent_id ? { agentId: payload.agent_id } : {}),
        isSubagent: true,
      },
    };
  }
  if (!payload.session_id || !payload.transcript_path) return null;
  return {
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    hook: { payloadSessionId: payload.session_id, isSubagent: false },
  };
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
  let payload: StopHookPayload;
  try { payload = JSON.parse(data); } catch { process.exit(0); }
  if (payload.stop_hook_active) process.exit(0); // recursion guard
  const target = resolveIngestTarget(payload);
  if (!target) process.exit(0);

  let ingestedClass: 'hot' | 'agent' | undefined;
  let canonicalId = target.sessionId;
  try {
    // 5000 ms busy_timeout for hook DB writes. The wasm-era 500 ms was a
    // contention dodge (its coarse mkdir lock blocked even readers); under real
    // WAL a writer never blocks a reader and short writes settle well inside
    // 5 s, so match db.ts's default. Inside the try so a DB open/init failure —
    // including a BindingLoadError or a pending-migration fail-closed throw —
    // is logged and swallowed: the hook must always exit 0 and never block the
    // user's turn (T1 re-ingests the gap after a migration completes).
    getDb(dbPath()).exec("PRAGMA busy_timeout = 5000;");

    const vendor = vendorForTranscript(target.transcriptPath);

    const result = await ingestSessionMessages(
      target.sessionId,
      target.transcriptPath,
      vendor,
      { projectId: payload.cwd ?? undefined, hook: target.hook },
    );
    ingestedClass = result?.retrievalClass;
    canonicalId = result?.sessionId ?? target.sessionId;
    // ingestSessionMessages reports soft failures via { error } rather than
    // throwing — log those too, else they vanish silently.
    if (result?.error) {
      logStopHook(
        `${new Date().toISOString()} ingest-failed sid=${target.sessionId} err=${result.error}\n`,
      );
    }
  } catch (e) {
    logStopHook(
      `${new Date().toISOString()} ingest-failed sid=${target.sessionId} err=${(e as Error).message}\n`,
    );
  }

  // Detach an embed-pending child to vectorize anything still missing.
  // The lockfile inside the child guarantees at most one llama-server runs
  // across the host; siblings exit 0 silently when the lock is held.
  //
  // A subagent-only ingest must NOT spawn one: agent leaves create no
  // embedding-eligible gap (they are excluded from every gap selector), so a
  // SubagentStop child would be pure detached churn.
  if (!target.hook.isSubagent && ingestedClass !== 'agent') {
    spawn(
      process.execPath,
      [join(binDir(), "embed-pending.js"), canonicalId],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    ).unref();
  }

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
