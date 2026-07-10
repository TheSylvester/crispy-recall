/**
 * recall — Unified CLI — session transcript memory.
 *
 * Argument inference:
 *   recall "query"                  → search mode
 *   recall <session-id>             → read session messages
 *   recall <session-id> <msg-id>    → read a specific turn
 *   recall --list                   → list sessions
 *   recall --help                   → usage
 *
 * Flags:
 *   --limit N     Max results (default varies by mode)
 *   --offset N    Pagination offset for session reads
 *   (message-id auto-centers the read window on the matched turn)
 *   --since DATE  Filter by date (list/search modes; ISO-8601)
 *   --raw         JSON output instead of formatted tables
 *   --help        Print usage
 *   --list        List sessions
 *
 * Search mode uses dual-path (FTS5 + semantic) search with score-gap cutoff
 * and deduplication by session.
 */

import { dualPathSearch } from '../recall/vector-search.js';
import { disposeEmbedder } from '../recall/embedder.js';
import { getDb, closeDb } from '../db.js';
import { getDbPath, listSessions } from '../recall/memory-queries.js';
import { readSessionMessages, getMessageByUuid } from '../recall/message-store.js';
import { normalizePath } from '../url-path-resolver.js';
import { mtimeScan } from '../recall/mtime-scan.js';
import {
  startRecallCatchup,
  setCancelFlag,
  clearCancelFlag,
} from '../recall/catchup.js';
import { logsDir, runDir } from '../paths.js';
import {
  findSessionsForCommit,
  findSessionsForBlame,
  parseBlameSpec,
  type SessionMatch,
} from '../git-attribution.js';
import { renderStatuslineSegment, type StatuslineInput } from '../recall/statusline-segment.js';
import { mkdirSync, openSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * "Session-shaped" — the NARROW test that routes an implicit positional to a
 * read instead of a search. A positional qualifies only if it contains no
 * whitespace and matches either:
 *   - an 8+ hex-char UUID prefix (up to a full 36-char UUID), or
 *   - the stored `agent-<hex>` leaf pattern (NOT any string beginning
 *     "agent-": `recall agent-based retrieval` must remain a search).
 * Anything else falls through to search. Opaque/descriptive references that
 * don't fit this shape are still readable via the explicit `recall read`
 * form, and a search can always be forced with `recall search …`.
 */
const UUIDISH_SESSION = /^[0-9a-f]{8}[0-9a-f-]{0,28}$/i;
const AGENT_SESSION = /^agent-[0-9a-f]+$/i;

function isSessionShaped(s: string): boolean {
  return UUIDISH_SESSION.test(s) || AGENT_SESSION.test(s);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

function flagValue(name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function flagInt(name: string, fallback: number): number {
  const v = flagValue(name);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

const raw = hasFlag('--raw');
// --raw-messages: emit the FULL pre-shaping per-message ranked list (bypasses
// score-gap cutoff + session-dedup + pagination) as a JSON object. For per-turn
// retrieval scoring (e.g. recall@k harnesses) that need individual turns, not
// session rows. --no-idf bypasses the FTS5 IDF high-frequency-term filter.
const rawMessages = hasFlag('--raw-messages');
const noIdf = hasFlag('--no-idf');
const showHelp = hasFlag('--help') || hasFlag('-h');
const showVersion = hasFlag('--version') || hasFlag('-v');
const listMode = hasFlag('--list');
const limit = flagInt('--limit', -1);   // -1 = use mode default
const offset = flagInt('--offset', 0);
// --context is accepted but ignored (centering is automatic when message-id is given)
const since = flagValue('--since');
const until = flagValue('--until');
const projectFlag = flagValue('--project');
const allProjects = hasFlag('--all');
const reverse = hasFlag('--reverse');
const recent = hasFlag('--recent');
const commitFlag = flagValue('--commit');
const blameMode = hasFlag('--blame');

/**
 * Clean termination WITHOUT exit(). On Windows, exit() aborts
 * with a libuv `UV_HANDLE_CLOSING` assertion (exit 0xC0000409) when
 * node-sqlite3-wasm's Emscripten runtime still holds an async handle — closing
 * the DB does NOT help; only letting the event loop drain naturally does. So we
 * set the exit code and throw a sentinel that unwinds to main()'s handler,
 * which disposes the embedder + DB and returns, letting the process exit on its
 * own. The 3 try/catch blocks in this file do not wrap any exit() site.
 */
class ExitSignal extends Error {
  constructor(public readonly code: number) { super(`exit:${code}`); }
}
function exit(code: number): never {
  process.exitCode = code;
  throw new ExitSignal(code);
}

// Project scoping: default to CWD (inherited from parent session's projectPath),
// --project overrides, --all disables scoping entirely.
const effectiveProject = allProjects ? undefined : normalizePath(projectFlag ?? process.cwd());

// Collect positional args (skip flags and their values)
// --commit / --blame consume positionals separately below.
const FLAG_WITH_VALUE = new Set(['--limit', '--offset', '--since', '--until', '--project', '--vendor', '--commit']);
const FLAG_BOOLEAN = new Set([
  '--raw', '--raw-messages', '--no-idf',
  '--help', '-h', '--version', '-v', '--list', '--all', '--reverse', '--recent', '--blame',
  '--no-catchup', '--auto-embed', '--detach',
  // installer subcommand flags
  '--yes', '--offline', '--json', '--purge', '--integrity',
  '--fts', '--vectors', '--full', '--no-claudemd', '--no-backfill', '--auto-backfill',
  '--statusline', '--no-statusline',
  // statusline subcommand flag
  '--suggest',
]);

const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (FLAG_BOOLEAN.has(a)) continue;
  if (FLAG_WITH_VALUE.has(a)) { i++; continue; }
  positional.push(a);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** Read the package version from the bundle's sibling package.json. */
function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  console.log(`
recall — Unified CLI — session transcript memory.

USAGE
  recall "query"                     Search sessions by text
  recall search <terms…>             Search explicitly (escape hatch when a
                                     term looks like a session/message ID)
  recall <session-id>                Read messages from a session
  recall <session-id> <message-id>   Read centered on matched message
  recall read <session-ref> [<message-ref>]
                                     Explicit read — references are opaque
                                     stored IDs or literal prefixes; a failed
                                     read exits nonzero (never searches)
  recall --list                      List recent sessions
  recall --commit <hash>             Sessions that produced a commit
  recall --blame <path>[:<line>[-<line>]]...  Sessions responsible for a file
                                     or a specific line/range (via git blame)
  recall backfill [flags]            Catch up FTS5 + embeddings against transcript files
  recall statusline [--suggest]      Print the session-id chip for the Claude Code
                                     statusline (or, with --suggest, detect your
                                     current statusline and show how to add it)

ARGUMENTS
  query         Free-text search (FTS5 + optional semantic)
  session-id    Full stored session ID or a literal prefix of one. IDs are
                opaque — UUIDs and agent-<hex> subagent leaves both work.
  message-id    Full stored message ID or a literal prefix, resolved within
                the session. Opaque — non-UUID IDs (e.g. codex-jsonl-*) work.

  Displayed IDs always round-trip: any session/message reference shown by
  search, list, or read output can be passed back to the CLI as-is.
  Bare-word dispatch only treats a first argument as a session reference if
  it looks like a UUID prefix (8+ hex chars) or agent-<hex>; anything else
  searches. Use \`recall read\` / \`recall search\` to force either mode.

FLAGS
  --limit N        Max results for search/list modes (search: 200, list: 50)
  --offset N       Continue reading from this message sequence number
  --since DATE     Only sessions after this date (list and search modes, ISO-8601)
  --until DATE     Only sessions before this date (inclusive of the day, ISO-8601)
  --project PATH   Scope to a specific project path (default: CWD)
  --all            Search across all projects (disables project scoping)
  --recent         Strongly boost recent sessions in search ranking
  --reverse        Read session messages newest-first (default: oldest-first)
  --raw            Output raw JSON instead of formatted tables
  --raw-messages   Output the FULL pre-shaping per-message ranked list as JSON
                   (bypasses score-gap cutoff, session-dedup, and pagination);
                   for per-turn retrieval scoring. Honors --limit as the top-k.
  --no-idf         Bypass the FTS5 IDF high-frequency-term filter (keeps
                   common-but-meaningful terms like when/before/after)
  --list           List sessions mode
  --commit HASH    Sessions that produced the given commit (git attribution)
  --blame SPEC...  Sessions responsible for a file or line range at HEAD; takes
                   one or more <path>[:<line>[-<line>]] specs (via git blame)
  --no-catchup     Skip the per-invocation mtime catch-up scan (T1)
  --help, -h       Show this help
  --version, -v    Print the recall version

INSTALL FLAGS (with 'recall install')
  --statusline     Opt in to showing the session id in your Claude Code
                   statusline. Writes ONLY into an empty slot; if you already
                   have a statusline it changes nothing and prints how to add
                   the id yourself. Stays on across upgrades once enabled.
                   Reversible on uninstall. (default: off)
  --no-statusline  Turn the statusline feature off: removes recall's statusline
                   entry (never someone else's) and its record
                   (wins over --statusline)

BACKFILL FLAGS (with 'recall backfill')
  --auto-embed     Skip the interactive prompt for large embedding gaps
  --vendor V       Restrict to one vendor: claude | codex (omit for both)
  --detach         Spawn a detached child and return immediately

WORKFLOW
  1. Search:  recall "your query"
  2. Read the matched message:  recall <session-id> <message-id>
     This auto-centers on the match and shows surrounding turns.
     Use --offset from the footer to continue reading forward.
  3. Only use recall <session-id> (no message-id) when you need
     to start from the beginning of a session.

EXAMPLES
  recall "MCP server rename"
  recall "refactored provider config" --limit 30 --since 2025-06-01
  recall "scroll bug" --since 2026-04-10 --until 2026-04-10
  recall a1b2c3d4 e5f6a7b8
  recall a1b2c3d4 --reverse
  recall --list --since 2026-04-10 --until 2026-04-10
  recall --commit 25dd0f8
  recall --blame src/paths.ts:82-84
  recall --blame src/foo.ts:42 src/bar.ts:10-20 --limit 20

COMMIT ATTRIBUTION (--commit / --blame)
  Returns the session(s) whose Edit/Write/MultiEdit tool calls structurally
  match each commit's diff. Sessions are listed chronologically (oldest first).
  The most recent is usually the load-bearing edit for current code; earlier
  sessions show evolution and may reveal originating intent or rejected
  approaches. --blame runs git blame to find the commits responsible for the
  current file (or line range) at HEAD, then attributes each. --limit (with
  --blame) caps the number of returned matches.
`.trim());
}

// ---------------------------------------------------------------------------
// Init DB
// ---------------------------------------------------------------------------

function initDb() {
  getDb(getDbPath());
}

/** Cap on candidate IDs printed for an ambiguous reference. */
const AMBIGUITY_LIST_MAX = 20;

/** How the user can force a search when a reference was misread as an ID. */
function searchEscapeHint(): string {
  return `To search for these terms instead, run: recall search ${positional.join(' ')}`;
}

/**
 * Resolve a stored session reference LITERALLY: exact stored ID first, then
 * exact alias (e.g. a hook agent_id recorded for a canonical Codex child),
 * then literal prefix over stored IDs and aliases. No character class is
 * assumed — `agent-*`, uppercase, `%`, `_`, and hyphens are all taken as-is
 * (prefix matching uses substr(), never LIKE, so no wildcard semantics leak).
 * A reference that does not resolve is an ID error (exit 1) — it must never
 * silently become a semantic search.
 */
function resolveSessionRef(ref: string): string {
  const d = getDb(getDbPath());
  const t = ref.trim();
  if (!t) {
    console.error('Empty session reference.');
    exit(1);
  }

  // Exact stored ID.
  if (d.get('SELECT 1 FROM messages WHERE session_id = ? LIMIT 1', [t])) return t;

  // Exact alias → canonical (session_aliases may predate this schema; tolerate absence).
  const viaAlias = lookupAliasExact(t);
  if (viaAlias) return viaAlias;

  // Literal prefix over stored IDs ∪ alias IDs (mapped to canonical).
  const candidates = new Set<string>();
  const rows = d.all(
    `SELECT DISTINCT session_id FROM messages
     WHERE substr(session_id, 1, ?) = ?
     ORDER BY session_id ASC LIMIT ${AMBIGUITY_LIST_MAX + 1}`,
    [t.length, t],
  ) as { session_id: string }[];
  for (const r of rows) candidates.add(r.session_id);
  for (const canonical of lookupAliasPrefix(t)) candidates.add(canonical);

  if (candidates.size === 0) {
    console.error(`No session found matching "${ref}".`);
    console.error(searchEscapeHint());
    exit(1);
  }
  if (candidates.size > 1) {
    console.error(`Ambiguous session reference "${ref}" — matches multiple sessions:`);
    for (const id of [...candidates].sort().slice(0, AMBIGUITY_LIST_MAX)) console.error(`  ${id}`);
    if (candidates.size > AMBIGUITY_LIST_MAX) console.error(`  …and ${candidates.size - AMBIGUITY_LIST_MAX} more`);
    console.error(searchEscapeHint());
    exit(1);
  }
  return [...candidates][0]!;
}

/** Exact alias lookup; null when absent (or on a pre-migration DB without the table). */
function lookupAliasExact(aliasId: string): string | null {
  try {
    const row = getDb(getDbPath()).get(
      'SELECT session_id FROM session_aliases WHERE alias_id = ?',
      [aliasId],
    ) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

/** Alias prefix lookup → canonical session IDs (empty on a pre-migration DB). */
function lookupAliasPrefix(prefix: string): string[] {
  try {
    const rows = getDb(getDbPath()).all(
      `SELECT DISTINCT session_id FROM session_aliases
       WHERE substr(alias_id, 1, ?) = ?
       ORDER BY session_id ASC LIMIT ${AMBIGUITY_LIST_MAX + 1}`,
      [prefix.length, prefix],
    ) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  } catch {
    return [];
  }
}

/**
 * Resolve a message reference within the (already canonical) session:
 * exact stored ID first, then literal prefix. Opaque — `codex-jsonl-*` and
 * other non-UUID IDs resolve like any other string.
 */
function resolveMessageRef(sessionId: string, ref: string): string {
  const d = getDb(getDbPath());
  const t = ref.trim();
  if (!t) {
    console.error('Empty message reference.');
    exit(1);
  }

  if (d.get('SELECT 1 FROM messages WHERE session_id = ? AND message_id = ? LIMIT 1', [sessionId, t])) {
    return t;
  }

  const rows = d.all(
    `SELECT DISTINCT message_id FROM messages
     WHERE session_id = ? AND substr(message_id, 1, ?) = ?
     ORDER BY message_id ASC LIMIT ${AMBIGUITY_LIST_MAX + 1}`,
    [sessionId, t.length, t],
  ) as { message_id: string }[];

  if (rows.length === 0) {
    console.error(`No message found in session ${sessionId} matching "${ref}".`);
    console.error(searchEscapeHint());
    exit(1);
  }
  if (rows.length > 1) {
    console.error(`Ambiguous message reference "${ref}" — matches multiple messages in session ${sessionId}:`);
    for (const r of rows.slice(0, AMBIGUITY_LIST_MAX)) console.error(`  ${r.message_id}`);
    if (rows.length > AMBIGUITY_LIST_MAX) console.error(`  …and more`);
    exit(1);
  }
  return rows[0]!.message_id;
}

// ---------------------------------------------------------------------------
// Mode: List sessions
// ---------------------------------------------------------------------------

function runList() {
  initDb();
  const effectiveLimit = limit > 0 ? limit : 50;
  const sessions = listSessions(getDbPath(), effectiveLimit, since, undefined, effectiveProject, until);

  if (raw) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  // Table output — session IDs are shown IN FULL (dynamic width) so every
  // displayed reference is copy-pasteable back into the CLI. IDs are opaque
  // (UUIDs, agent-<hex>, …); fixed truncation would break round-tripping.
  const idW = Math.max('Session'.length, ...sessions.map((s) => s.session_id.length)) + 2;
  const dateW = 12;
  const msgsW = 6;

  console.log(
    'Session'.padEnd(idW) +
    'Last active'.padEnd(dateW) +
    'Msgs'.padStart(msgsW) + '  ' +
    'Title'
  );
  console.log('-'.repeat(idW + dateW + msgsW + 10));

  for (const s of sessions) {
    const date = s.last_activity
      ? new Date(s.last_activity).toISOString().slice(0, 10)
      : 'unknown';
    console.log(
      s.session_id.padEnd(idW) +
      date.padEnd(dateW) +
      String(s.message_count).padStart(msgsW) + '  ' +
      (s.title || '(untitled)')
    );
  }

  console.log(`\n${sessions.length} session(s)`);
}

// ---------------------------------------------------------------------------
// Mode: Read session messages
// ---------------------------------------------------------------------------

const CHAR_BUDGET = parseInt(process.env.RECALL_CHAR_BUDGET || '20000', 10);
const FETCH_BATCH = 100; // fetch generously, budget-cap on output

function printMessages(
  page: NonNullable<ReturnType<typeof readSessionMessages>>,
  opts: { targetMessageId?: string; startOffset: number },
) {
  let totalChars = 0;
  let printed = 0;

  for (const m of page.messages) {
    const isTarget = opts.targetMessageId && m.message_id === opts.targetMessageId;
    const marker = opts.targetMessageId ? (isTarget ? '>>>' : '   ') : '';
    const role = m.role ?? (m.message_seq % 2 === 0 ? 'user' : 'assistant');
    const dateStr = m.created_at
      ? new Date(m.created_at).toISOString().slice(0, 19).replace('T', ' ')
      : '';

    // Format this message
    const header = `\n${marker}${marker ? ' ' : ''}[${m.message_seq}] ${role.toUpperCase()}  ${dateStr}`;
    const body = m.text;
    const msgChars = header.length + body.length;

    // Stop if adding this message would exceed budget (but always include at least 1)
    if (totalChars + msgChars > CHAR_BUDGET && printed > 0) break;

    console.log(header);
    console.log(body);
    totalChars += msgChars;
    printed++;
  }

  const nextOffset = opts.startOffset + printed;
  const hasMore = nextOffset < page.total_messages;
  if (hasMore) {
    const reverseFlag = reverse ? ' --reverse' : '';
    console.log(`\n--- ${printed} messages, ${totalChars} chars. Use${reverseFlag} --offset ${nextOffset} to see more (${page.total_messages - nextOffset} remaining) ---`);
  } else {
    console.log(`\n--- ${printed} messages, ${totalChars} chars. End of session. ---`);
  }
}

function runReadSession(sessionId: string) {
  const page = readSessionMessages(sessionId, offset, FETCH_BATCH, reverse);

  if (!page) {
    console.error(`No messages found for session ${sessionId}`);
    exit(1);
  }

  if (raw) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }

  console.log(`Session: ${page.session_id}`);
  console.log(`Messages: ${page.total_messages} total (reading from offset ${page.showing_offset})`);
  console.log('---');

  printMessages(page, { startOffset: offset });
}

// ---------------------------------------------------------------------------
// Mode: Read turn (centered on matched message)
// ---------------------------------------------------------------------------

function runReadTurn(sessionId: string, messageId: string) {
  const record = getMessageByUuid(sessionId, messageId);
  if (!record) {
    console.error(`Message ${messageId} not found in session ${sessionId}`);
    exit(1);
  }

  // Fetch a generous batch centered on the match
  const centeredOffset = Math.max(0, record.message_seq - Math.floor(FETCH_BATCH / 2));
  const page = readSessionMessages(sessionId, centeredOffset, FETCH_BATCH, reverse);

  if (!page) {
    console.error(`No messages found for session ${sessionId}`);
    exit(1);
  }

  if (raw) {
    console.log(JSON.stringify({ ...page, target_message_id: messageId, target_message_seq: record.message_seq }, null, 2));
    return;
  }

  // Find the match index in the fetched array
  const matchIdx = page.messages.findIndex(m => m.message_id === messageId);
  if (matchIdx === -1) {
    // Fallback: match not in fetched window, just print from offset
    console.log(`Session: ${page.session_id}`);
    console.log(`Match at seq ${record.message_seq} — ${page.total_messages} total`);
    console.log('---');
    printMessages(page, { targetMessageId: messageId, startOffset: centeredOffset });
    return;
  }

  // Expand outward from match: 30% budget backward, 70% forward
  const backBudget = Math.floor(CHAR_BUDGET * 0.3);
  const fwdBudget = CHAR_BUDGET - backBudget;

  // Expand backward from match (not including match itself)
  let backChars = 0;
  let firstIdx = matchIdx;
  for (let i = matchIdx - 1; i >= 0; i--) {
    const msgChars = page.messages[i]!.text.length + 80; // ~80 for header/metadata
    if (backChars + msgChars > backBudget) break;
    backChars += msgChars;
    firstIdx = i;
  }

  // Expand forward from match (including match itself)
  let fwdChars = 0;
  let lastIdx = matchIdx - 1; // will be incremented to at least matchIdx
  for (let i = matchIdx; i < page.messages.length; i++) {
    const msgChars = page.messages[i]!.text.length + 80;
    if (fwdChars + msgChars > fwdBudget && i > matchIdx) break; // always include match
    fwdChars += msgChars;
    lastIdx = i;
  }

  // If backward budget wasn't fully used, give remainder to forward
  const backRemaining = backBudget - backChars;
  if (backRemaining > 0) {
    for (let i = lastIdx + 1; i < page.messages.length; i++) {
      const msgChars = page.messages[i]!.text.length + 80;
      if (fwdChars + msgChars > fwdBudget + backRemaining) break;
      fwdChars += msgChars;
      lastIdx = i;
    }
  }

  // If forward budget wasn't fully used, give remainder to backward
  const fwdRemaining = fwdBudget - fwdChars;
  if (fwdRemaining > 0) {
    for (let i = firstIdx - 1; i >= 0; i--) {
      const msgChars = page.messages[i]!.text.length + 80;
      if (backChars + msgChars > backBudget + fwdRemaining) break;
      backChars += msgChars;
      firstIdx = i;
    }
  }

  const selected = page.messages.slice(firstIdx, lastIdx + 1);
  const firstSeq = selected[0]!.message_seq;
  const lastSeq = selected[selected.length - 1]!.message_seq;
  const nextOffset = lastSeq + 1;

  console.log(`Session: ${page.session_id}`);
  console.log(`Match at seq ${record.message_seq} — showing seq ${firstSeq}–${lastSeq} of ${page.total_messages}`);
  console.log('---');

  let totalChars = 0;
  for (const m of selected) {
    const isTarget = m.message_id === messageId;
    const marker = isTarget ? '>>>' : '   ';
    const role = m.role ?? (m.message_seq % 2 === 0 ? 'user' : 'assistant');
    const dateStr = m.created_at
      ? new Date(m.created_at).toISOString().slice(0, 19).replace('T', ' ')
      : '';
    console.log(`\n${marker} [${m.message_seq}] ${role.toUpperCase()}  ${dateStr}`);
    console.log(m.text);
    totalChars += m.text.length;
  }

  const hasMore = nextOffset < page.total_messages;
  if (hasMore) {
    console.log(`\n--- ${selected.length} messages, ${totalChars} chars. First: seq ${firstSeq}. Continue: --offset ${nextOffset} (${page.total_messages - nextOffset} remaining) ---`);
  } else {
    console.log(`\n--- ${selected.length} messages, ${totalChars} chars. First: seq ${firstSeq}. End of session. ---`);
  }
}

// ---------------------------------------------------------------------------
// Mode: Search
// ---------------------------------------------------------------------------

async function runSearch(query: string) {
  initDb();
  const ceiling = limit > 0 ? limit : 200;
  const r = await dualPathSearch(query, {
    limit: ceiling,
    projectId: effectiveProject,
    ...(noIdf ? { skipIdf: true } : {}),
    ...(recent ? { recencyDecay: 0.10 } : {}), // default is off; --recent opts into absolute age decay
  });
  let { scored } = r;

  // Filter by --since date if provided
  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!isNaN(sinceMs)) {
      scored = scored.filter(x => {
        const created = x.result.created_at ?? 0;
        return created >= sinceMs;
      });
    } else {
      console.error(`Invalid --since date: "${since}" (expected ISO-8601)`);
      exit(1);
    }
  }

  if (until) {
    const untilMs = new Date(until + 'T23:59:59.999').getTime();
    if (!isNaN(untilMs)) {
      scored = scored.filter(x => {
        const created = x.result.created_at ?? 0;
        return created <= untilMs;
      });
    } else {
      console.error(`Invalid --until date: "${until}" (expected ISO-8601)`);
      exit(1);
    }
  }

  // --- Raw per-message output (bypass all shaping) ---
  // Emit the full RRF-merged per-message ranked list (top `ceiling`), skipping
  // the score-gap cutoff, session-dedup, and pagination below. This is the
  // UNSHAPED list of individual turns that per-turn retrieval scorers consume.
  if (rawMessages) {
    const top = scored.slice(0, ceiling);
    console.log(JSON.stringify({
      query,
      no_idf: noIdf,
      semantic_available: r.semanticAvailable,
      semantic_count: r.semanticCount,
      fts_count: r.ftsCount,
      embed_coverage: r.embedCoverage,
      total: top.length,
      messages: top.map((x, i) => ({
        rank: i + 1,
        session_id: x.result.session_id,
        message_id: x.result.message_id,
        message_seq: x.result.message_seq,
        score: x.score,
        snippet: (x.result.match_snippet || x.result.message_preview || '')
          .slice(0, 200)
          .replace(/\n/g, ' '),
        tag: x.paths.includes('fts5') && x.paths.includes('semantic')
          ? 'FTS5+SEMANTIC'
          : x.paths.includes('semantic') ? 'SEMANTIC-ONLY' : 'FTS5-ONLY',
      })),
    }, null, 2));
    return;
  }

  // --- Score-gap cutoff ---
  // Scan from position 10 onward. Find the largest relative drop between
  // consecutive scores. If > 15%, truncate there.
  let cutoffIdx = scored.length;
  if (scored.length > 10) {
    let maxDrop = 0;
    let maxDropIdx = -1;
    for (let i = 10; i < scored.length - 1; i++) {
      const curr = scored[i]!.score;
      const next = scored[i + 1]!.score;
      if (curr > 0) {
        const drop = (curr - next) / curr;
        if (drop > maxDrop) {
          maxDrop = drop;
          maxDropIdx = i + 1;
        }
      }
    }
    if (maxDrop > 0.15) {
      cutoffIdx = maxDropIdx;
    }
  }

  const trimmed = scored.slice(0, cutoffIdx);

  // --- Deduplicate by session_id, keep highest-ranked entry ---
  interface SessionRow {
    rank: number;
    session_id: string;
    short_id: string;
    date: string;
    snippet: string;
    hits: number;
    score: number;
    best_message_id: string;
    best_message_seq: number;
    tag: string;
  }

  const sessions: SessionRow[] = [];
  const seen = new Map<string, number>();
  const sessionPaths = new Map<string, Set<string>>();

  for (let i = 0; i < trimmed.length; i++) {
    const x = trimmed[i]!;
    const sid = x.result.session_id;

    let pathSet = sessionPaths.get(sid);
    if (!pathSet) {
      pathSet = new Set<string>();
      sessionPaths.set(sid, pathSet);
    }
    for (const p of x.paths) pathSet.add(p);

    const idx = seen.get(sid);
    if (idx !== undefined) {
      sessions[idx]!.hits++;
    } else {
      seen.set(sid, sessions.length);
      sessions.push({
        rank: sessions.length + 1,
        session_id: sid,
        short_id: sid.slice(0, 8),
        date: x.result.created_at
          ? new Date(x.result.created_at).toISOString().slice(0, 10)
          : 'unknown',
        snippet: (x.result.match_snippet || x.result.message_preview || '')
          .slice(0, 400)
          .replace(/\n/g, ' '),
        hits: 1,
        score: x.score,
        best_message_id: x.result.message_id,
        best_message_seq: x.result.message_seq,
        tag: '',
      });
    }
  }

  for (const s of sessions) {
    const paths = sessionPaths.get(s.session_id);
    if (paths?.has('fts5') && paths?.has('semantic')) {
      s.tag = '[FTS5+SEMANTIC]';
    } else if (paths?.has('semantic')) {
      s.tag = '[SEMANTIC-ONLY]';
    } else {
      s.tag = '[FTS5-ONLY]';
    }
  }

  // --- Paginate sessions ---
  const PAGE_SIZE = 75;
  const totalSessions = sessions.length;
  const pageStart = Math.min(offset, totalSessions);
  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalSessions);
  const page = sessions.slice(pageStart, pageEnd);
  const hasMore = pageEnd < totalSessions;

  // --- Output ---
  if (raw) {
    console.log(JSON.stringify({
      query,
      total_messages: trimmed.length,
      total_before_cutoff: scored.length,
      cutoff_applied: cutoffIdx < scored.length,
      fts_count: r.ftsCount,
      semantic_count: r.semanticCount,
      semantic_available: r.semanticAvailable,
      embed_coverage: r.embedCoverage,
      unique_sessions: totalSessions,
      showing_offset: pageStart,
      showing_count: page.length,
      has_more: hasMore,
      sessions: page,
    }, null, 2));
  } else {
    console.log(`Query: "${query}"`);
    console.log(`Results: ${trimmed.length} messages, ${totalSessions} unique sessions (showing ${pageStart + 1}-${pageEnd})`);
    const migrating = r.embedCoverage < 0.95
      ? `  (migrating: ${Math.round(r.embedCoverage * 100)}% re-embedded)`
      : '';
    console.log(`Paths: FTS5=${r.ftsCount}  Semantic=${r.semanticCount} (${r.semanticAvailable ? 'active' : 'UNAVAILABLE'})${migrating}`);
    if (cutoffIdx < scored.length) {
      console.log(`Cutoff: position ${cutoffIdx} of ${scored.length} (score gap detected)`);
    }
    console.log('---');

    // Session/message references are shown IN FULL with dynamic column widths
    // so every displayed row round-trips into `recall <session> <message>`.
    // IDs are opaque (UUIDs, agent-<hex>, codex-jsonl-*, …) — fixed 8-char
    // truncation produced ambiguous, non-resolvable references.
    const rankW = 4;
    const idW = Math.max('Session'.length, ...page.map((s) => s.session_id.length)) + 2;
    const msgW = Math.max('Msg'.length, ...page.map((s) => s.best_message_id.length)) + 2;
    const dateW = 12;
    const tagW = 17;
    const hitsW = 6;

    console.log(
      '#'.padStart(rankW) + '  ' +
      'Session'.padEnd(idW) +
      'Msg'.padEnd(msgW) +
      'Date'.padEnd(dateW) +
      'Tag'.padEnd(tagW) +
      'Hits'.padStart(hitsW) + '  ' +
      'Snippet'
    );

    for (const s of page) {
      console.log(
        String(s.rank).padStart(rankW) + '  ' +
        s.session_id.padEnd(idW) +
        s.best_message_id.padEnd(msgW) +
        s.date.padEnd(dateW) +
        s.tag.padEnd(tagW) +
        String(s.hits).padStart(hitsW) + '  ' +
        s.snippet
      );
    }

    if (hasMore) {
      console.log(`\n--- Showing ${pageStart + 1}-${pageEnd} of ${totalSessions} sessions. Next page: --offset ${pageEnd} ---`);
    }
  }
}

// ---------------------------------------------------------------------------
// Mode: Commit attribution (--commit / --blame)
// ---------------------------------------------------------------------------

/** Collect all positionals trailing `--blame`, stopping at the next flag. */
function blamePositionals(): string[] {
  const idx = argv.indexOf('--blame');
  if (idx < 0) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

function printCommitAttribution(query: string, matches: SessionMatch[]) {
  const note = 'Sessions are listed chronologically (oldest first). The most recent is usually the load-bearing one for current code; earlier sessions show evolution and may reveal originating intent or rejected approaches.';

  if (raw) {
    console.log(JSON.stringify({
      query,
      note,
      count: matches.length,
      matches,
    }, null, 2));
    return;
  }

  console.log(`Query: ${query}`);
  console.log(`Matches: ${matches.length}`);
  console.log(`Note: ${note}`);
  console.log('---');

  if (matches.length === 0) {
    console.log('No sessions matched.');
    return;
  }

  // Session ids are shown in full — a UUID is 36 chars and 'agent-<hash>'
  // varies — with the column sized to the widest label so the id never
  // truncates or merges into the Commit column. A fixed GAP separates every
  // column. Subagent leaves get a trailing ' ↳' marker.
  const sessLabels = matches.map((m) =>
    m.parent_session_id ? `${m.session} ↳` : m.session,
  );
  const sessW = Math.max('Session'.length, ...sessLabels.map((s) => s.length));
  const commitW = 12;
  const hitsW = 6;
  const survW = 5;
  const ratioW = 6;
  const dateW = 19;   // 'YYYY-MM-DD HH:MM:SS'
  const GAP = '  ';

  const header =
    'Session'.padEnd(sessW) + GAP +
    'Commit'.padEnd(commitW) + GAP +
    'Hits'.padStart(hitsW) + GAP +
    'Surv?'.padEnd(survW) + GAP +
    'Ratio'.padStart(ratioW) + GAP +
    'Last edit'.padEnd(dateW) + GAP +
    'Files';
  console.log(header);
  console.log('-'.repeat(header.length));

  matches.forEach((m, i) => {
    const date = m.last_edit_at.slice(0, 19).replace('T', ' ');
    console.log(
      sessLabels[i]!.padEnd(sessW) + GAP +
      m.commit.slice(0, 10).padEnd(commitW) + GAP +
      String(m.content_hits).padStart(hitsW) + GAP +
      (m.surviving_in_commit ? 'yes' : 'no').padEnd(survW) + GAP +
      String(m.surviving_ratio).padStart(ratioW) + GAP +
      date.padEnd(dateW) + GAP +
      m.matched_files.join(', '),
    );
    if (m.parent_session_id) {
      console.log(
        ' '.repeat(2) +
        `(subagent of ${m.parent_session_id.slice(0, 8)}${m.agent_type ? `, type=${m.agent_type}` : ''})`,
      );
    }
  });
}

async function runCommitAttribution() {
  // Raw path on purpose: the Claude project slug is derived from the exact
  // cwd string Claude ran with — normalizePath() would corrupt it (e.g.
  // lowercased Windows drive letters).
  const repoRoot = projectFlag ?? process.cwd();

  if (hasFlag('--commit')) {
    if (commitFlag === undefined || commitFlag.startsWith('--')) {
      console.error('--commit requires a commit hash. Use --help for usage.');
      exit(1);
    }
    let matches: SessionMatch[];
    try {
      matches = await findSessionsForCommit(commitFlag, { repoRoot });
    } catch (err) {
      console.error(`recall --commit: git failed for "${commitFlag}" in ${repoRoot}: ${gitErrLine(err)}`);
      exit(1);
    }
    printCommitAttribution(`--commit ${commitFlag}`, matches);
    return;
  }

  const rawSpecs = blamePositionals();
  if (rawSpecs.length === 0) {
    console.error('--blame requires at least one path or path:line[-line] spec. Use --help for usage.');
    exit(1);
  }
  const specs = rawSpecs.map(parseBlameSpec);
  const matchLimit = limit > 0 ? limit : undefined;
  let matches: SessionMatch[];
  try {
    matches = await findSessionsForBlame(specs, { repoRoot, ...(matchLimit !== undefined ? { limit: matchLimit } : {}) });
  } catch (err) {
    console.error(`recall --blame: ${gitErrLine(err)}`);
    exit(1);
  }
  printCommitAttribution(`--blame ${rawSpecs.join(' ')}`, matches);
}

/** First useful line of a git/attribution failure: prefer captured stderr. */
function gitErrLine(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n')[0]!;
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mode: backfill (T3)
// ---------------------------------------------------------------------------

function parseVendors(): ('claude' | 'codex')[] | undefined {
  const v = flagValue('--vendor');
  if (!v) return undefined;
  if (v === 'claude' || v === 'codex') return [v];
  console.error(`Invalid --vendor "${v}" (expected "claude" or "codex")`);
  exit(1);
}

async function runBackfill() {
  initDb();

  // SIGINT handler — sets cancel flag so the per-batch transaction can finish.
  process.on('SIGINT', () => {
    setCancelFlag();
    process.stderr.write('[recall] cancel requested — finishing current batch then exiting\n');
  });
  // Reset cancel flag in case an installer retries within one process.
  clearCancelFlag();

  const detach = hasFlag('--detach');
  if (detach) {
    // Spawn `node dist/recall.js backfill --auto-embed [--vendor X]` detached.
    mkdirSync(logsDir(), { recursive: true });
    mkdirSync(runDir(), { recursive: true });
    const logPath = join(logsDir(), 'backfill.log');
    const logFd = openSync(logPath, 'a');
    const args = [process.argv[1]!, 'backfill', '--auto-embed'];
    const vendors = parseVendors();
    if (vendors) { args.push('--vendor', vendors[0]!); }
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    if (child.pid !== undefined) {
      writeFileSync(join(runDir(), 'backfill.pid'), String(child.pid));
    }
    child.unref();
    process.stderr.write(`[recall] backfill detached (pid=${child.pid}, log=${logPath})\n`);
    exit(0);
  }

  const autoEmbed = hasFlag('--auto-embed');
  const vendors = parseVendors();

  await startRecallCatchup({ autoEmbed, ...(vendors ? { vendors } : {}) });

  // Post-run sweep: pick up files that grew during the run (plan §5.14 "Gap C").
  // Phase 1's FTS5 catch-up inside startRecallCatchup skips sessions already
  // in getIndexedSessionIds(), so a session that was partially ingested before
  // backfill started but grew during it would otherwise be missed.
  try {
    await mtimeScan(vendors ? { vendors } : undefined);
  } catch (e) {
    process.stderr.write(`[recall] post-backfill mtime-scan failed: ${(e as Error).message}\n`);
  }
}

// ---------------------------------------------------------------------------
// T1 wiring — opportunistic mtime-scan before any DB-touching subcommand.
// ---------------------------------------------------------------------------

const T1_SKIP = new Set(['backfill', 'status', 'doctor', 'repair', 'uninstall']);

async function maybeRunT1() {
  const skipForFlag = hasFlag('--help') || hasFlag('-h') || hasFlag('--version');
  const firstPositional = positional[0] ?? '';
  if (hasFlag('--no-catchup') || skipForFlag || T1_SKIP.has(firstPositional)) return;
  const t0 = Date.now();
  try {
    initDb();
    await mtimeScan();
  } catch (e) {
    // A pending schema migration must fail the WHOLE command closed with the
    // concise remediation, not degrade into a broken search/read.
    if ((e as Error).name === 'MigrationPendingError') throw e;
    process.stderr.write(`[recall] mtime-scan failed (continuing): ${(e as Error).message}\n`);
  }
  const dt = Date.now() - t0;
  if (dt > 500) {
    process.stderr.write(`[recall] mtime-scan took ${dt}ms (target ≤200ms; consider RECALL_LOG=debug to diagnose)\n`);
  }
}

// ---------------------------------------------------------------------------
// Installer subcommands (install / uninstall / status / doctor / repair)
// ---------------------------------------------------------------------------

const INSTALLER_SUBCOMMANDS = new Set(['install', 'uninstall', 'status', 'doctor', 'repair']);

async function runInstallerSubcommand(cmd: string): Promise<void> {
  const json = hasFlag('--json');

  if (cmd === 'install') {
    const { runInstall } = await import('../installer/install.js');
    const res = await runInstall({
      yes: hasFlag('--yes'),
      offline: hasFlag('--offline'),
      noClaudemd: hasFlag('--no-claudemd'),
      statusline: hasFlag('--statusline'),
      noStatusline: hasFlag('--no-statusline'),
      noBackfill: hasFlag('--no-backfill'),
      autoBackfill: hasFlag('--auto-backfill'),
      json,
    });
    if (json) console.log(JSON.stringify(res, null, 2));
    exit(res.aborted ? 1 : 0);
  }

  if (cmd === 'uninstall') {
    const { runUninstall } = await import('../installer/uninstall.js');
    const res = runUninstall({ purge: hasFlag('--purge'), json });
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.log(`recall uninstalled — removed ${res.removed.length} target(s)${res.purged ? ' (purged ~/.recall)' : ''}.`);
    exit(0);
  }

  if (cmd === 'status') {
    const { printStatus } = await import('../installer/status.js');
    printStatus(json);
    exit(0);
  }

  if (cmd === 'doctor') {
    const { runDoctor } = await import('../installer/doctor.js');
    const code = await runDoctor({ json, integrity: hasFlag('--integrity'), offline: hasFlag('--offline') });
    exit(code);
  }

  if (cmd === 'repair') {
    const { repairFts, repairVectors, repairFull } = await import('../installer/repair.js');
    if (hasFlag('--fts')) { repairFts(); console.log('FTS5 index rebuilt.'); exit(0); }
    if (hasFlag('--vectors')) { repairVectors(); console.log('Vectors cleared — they re-embed on the next sweep.'); exit(0); }
    if (hasFlag('--full')) { await repairFull({ yes: hasFlag('--yes') }); exit(0); }
    console.error('recall repair: specify --fts, --vectors, or --full');
    exit(1);
  }
}

/**
 * `recall statusline` — manual/composition entry point for the Claude Code
 * statusLine. NEVER opens the DB (dispatched before initDb/maybeRunT1).
 *
 *   recall statusline --suggest   Detect the current statusline + print guidance
 *   <json> | recall statusline    Print recall's chip: "🔗 <session_id>"
 *
 * The WIRED status line is the lean dist/statusline.js bundle, not this — the
 * full CLI statically imports db/embedder. This subcommand is for manual use.
 */
async function runStatuslineSubcommand(): Promise<void> {
  if (hasFlag('--suggest')) {
    const { detectStatusline, renderStatuslineSuggestion } = await import('../installer/statusline-suggest.js');
    const { claudeSettingsPath } = await import('../installer/preflight.js');
    console.log(renderStatuslineSuggestion(detectStatusline(claudeSettingsPath())));
    exit(0);
  }
  // No piped stdin on a TTY → don't hang on `for await`; print usage and exit.
  if (process.stdin.isTTY) {
    console.log('Usage: pipe the Claude statusline JSON to `recall statusline`, or run `recall statusline --suggest`.');
    exit(0);
  }
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  let json: StatuslineInput;
  try { json = JSON.parse(data) as StatuslineInput; } catch { json = {}; }
  process.stdout.write(renderStatuslineSegment(json ?? {}));
  exit(0);
}

async function main() {
  if (showVersion) {
    console.log(getVersion());
    exit(0);
  }

  if (showHelp) {
    printHelp();
    exit(0);
  }

  // Commit attribution — dispatched before the positional subcommands so a
  // blame spec that happens to be named like one (`--blame install`) is never
  // hijacked, and before maybeRunT1() because this mode never touches the DB
  // (it reads git + raw transcript JSONL directly).
  if (hasFlag('--commit') || blameMode) {
    await runCommitAttribution();
    exit(0);
  }

  // Statusline subcommand — AFTER the commit/blame block so `recall --blame
  // statusline` (blaming a file literally named `statusline`) reaches git-blame,
  // consistent with how backfill/installer subcommands are ordered. Still BEFORE
  // any DB/embedder init and maybeRunT1: it never touches the DB, and its
  // TTY-guarded stdin read must never open/block on the database. Only a LONE
  // `statusline` dispatches — the subcommand takes no positional args, so a
  // search like `recall statusline broken yesterday` falls through to search
  // instead of being silently swallowed (exit 0, no output) on piped stdin.
  if (positional[0] === 'statusline' && positional.length === 1) {
    await runStatuslineSubcommand();
    exit(0);
  }

  // Backfill subcommand — skip T1 (it covers everything itself).
  if (positional[0] === 'backfill') {
    await runBackfill();
    exit(0);
  }

  // Installer subcommands — skip T1 (they manage their own DB/lifecycle).
  if (positional[0] && INSTALLER_SUBCOMMANDS.has(positional[0])) {
    await runInstallerSubcommand(positional[0]);
    exit(0);
  }

  // Opportunistic catch-up for everything that touches the DB.
  await maybeRunT1();

  if (listMode) {
    runList();
    exit(0);
  }

  // Explicit read: `recall read <session-ref> [<message-ref>]`. References are
  // OPAQUE stored IDs or literal prefixes — no shape requirement, so
  // descriptive agent IDs and other non-UUID identifiers are reachable here.
  // A failed explicit read always exits nonzero; it never becomes a search.
  if (positional[0] === 'read') {
    const refs = positional.slice(1);
    if (refs.length === 0 || refs.length > 2) {
      console.error(`recall read takes a session reference and an optional message reference (${refs.length} given).`);
      console.error('Usage: recall read <session-ref> [<message-ref>]');
      exit(1);
    }
    runRead(refs[0]!, refs[1]);
    exit(0);
  }

  // Explicit search: `recall search <terms…>` — the documented escape hatch
  // when a query would otherwise be captured by read dispatch (e.g. a leading
  // hex-shaped or agent-<hex>-shaped token).
  if (positional[0] === 'search') {
    const query = positional.slice(1).join(' ');
    if (!query) {
      console.error('recall search requires at least one term. Usage: recall search <terms…>');
      exit(1);
    }
    await runSearch(query);
    exit(0);
  }

  // Implicit read dispatch — only for narrowly session-shaped first tokens
  // (see isSessionShaped). Exactly one positional → session read; exactly two
  // → centered read with the second treated as an OPAQUE message reference
  // (no UUID grammar — codex-jsonl-* etc. resolve literally). Three or more
  // positionals in a read shape are an error, never truncated to two.
  if (positional.length >= 1 && isSessionShaped(positional[0]!)) {
    if (positional.length > 2) {
      console.error(`"${positional[0]}" looks like a session reference, but ${positional.length} positional arguments were given — reads take at most a session and a message reference.`);
      console.error(`  To read:   recall read ${positional[0]} [<message-ref>]`);
      console.error(`  To search: recall search ${positional.join(' ')}`);
      exit(1);
    }
    runRead(positional[0]!, positional[1]);
    exit(0);
  }

  // Otherwise → search query
  const query = positional.join(' ');
  if (!query) {
    console.error('No query provided. Use --help for usage.');
    exit(1);
  }

  await runSearch(query);
  exit(0);
}

/** Shared read driver: resolve refs literally, then read/center. */
function runRead(sessionRef: string, messageRef?: string): void {
  initDb();
  const sessionId = resolveSessionRef(sessionRef);
  if (messageRef !== undefined) {
    const messageId = resolveMessageRef(sessionId, messageRef);
    runReadTurn(sessionId, messageId);
  } else {
    runReadSession(sessionId);
  }
}

main()
  .catch((e) => {
    if (e instanceof ExitSignal) return; // intentional termination; exitCode already set
    if ((e as Error)?.name === 'MigrationPendingError') {
      // Fail closed, concisely: the DB predates the retrieval-class schema and
      // only the attended `recall install` migration may rewrite it.
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Release the resident embedder (kills any llama-server + clears its idle
    // timer) and close the DB so the event loop drains and the process exits
    // naturally — avoiding the Windows process.exit() libuv assertion.
    try { await disposeEmbedder(); } catch { /* ignore */ }
    try { closeDb(); } catch { /* ignore */ }
  });
