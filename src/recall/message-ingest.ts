/**
 * Message Ingest — Per-session message-level ingestion for the recall pipeline
 *
 * Loads a session through the vendor adapter, strips tool content, and stores
 * one row per user/assistant entry in the messages table. FTS5 indexing
 * happens automatically via triggers on insert.
 *
 * Also handles semantic embedding: after messages are indexed, they can be
 * embedded with Nomic Embed Code and stored as q8 vectors for dual-path search.
 *
 * Preserves message boundaries and uses the entry's uuid as the primary key.
 * Sub-agent entries (those with parentToolUseID) are excluded — the parent
 * session's assistant entries already contain sub-agent output via the Task
 * tool result.
 *
 * Also owns the IngestResult/IngestOptions types used by both this module
 * and the backfill CLI.
 *
 * Designed for both real-time (single session) and batch (backfill) use.
 *
 * Owns: session-level message ingestion + embedding orchestration, ingest types.
 * Does not: discover sessions, manage concurrency, own CLI parsing.
 *
 * @module recall/message-ingest
 */

import { stripToolContent } from './transcript-utils.js';
import {
  insertMessages,
  insertMessageVectors,
} from './message-store.js';
import type { MessageRecord, MessageVectorRecord } from './message-store.js';
import { DOC_PREFIX, EMBED_VERSION, buildEmbedText } from './embed-config.js';
import { getDb } from '../db.js';
import { dbPath } from '../paths.js';
import { normalizePath } from '../url-path-resolver.js';
import { log } from '../log.js';
import { parseJsonlFile } from '../adapters/claude/jsonl-reader.js';
import { adaptClaudeEntries } from '../adapters/claude/claude-entry-adapter.js';
import { parseCodexJsonlFile } from '../adapters/codex/codex-jsonl-reader.js';
import { adaptCodexJsonlRecords } from '../adapters/codex/codex-jsonl-adapter.js';
import type { TranscriptEntry } from '../transcript.js';

// ============================================================================
// Types (originally from ingest.ts, moved here after chunk pipeline removal)
// ============================================================================

export interface IngestResult {
  sessionId: string;
  chunksCreated: number;
  skipped: boolean;
  error?: string;
}

export interface IngestOptions {
  projectId?: string;
  force?: boolean;
  verbose?: boolean;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract text content from a single transcript entry.
 *
 * Handles both string and array content formats. For array content, joins
 * only text blocks (filtering out tool_use, tool_result, thinking, etc.).
 * Returns empty string if no text content remains.
 */
export function extractEntryText(entry: TranscriptEntry): string {
  const msg = entry.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text?: string }).text?.trim())
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * Find the working directory recorded on a session's transcript entries.
 *
 * Claude and Codex both stamp `cwd` on their entries; it's constant for a
 * session. Returns the first non-empty value, or undefined if none carry one
 * (e.g. transcripts of internal/operation entries only).
 */
function entriesCwd(entries: TranscriptEntry[]): string | undefined {
  for (const e of entries) {
    if (e.cwd) return e.cwd;
  }
  return undefined;
}

/**
 * Ingest a session's messages into the message-level recall index.
 *
 * Flow:
 *   1. Check if already processed (skip unless force)
 *   2. Load entries through the vendor reader on the given transcript path
 *   3. Resolve project_id (caller-provided cwd, else the transcript's own cwd)
 *   4. Strip tool content, filter sub-agent entries
 *   5. Extract text per entry, build MessageRecords
 *   6. Batch insert into SQLite (FTS5 triggers fire automatically)
 *
 * @param sessionId       The session ID to ingest.
 * @param transcriptPath  Absolute path to the vendor JSONL file.
 * @param vendor          Vendor format of the transcript ('claude' | 'codex').
 * @param options         Processing options (force, verbose, projectId).
 * @returns               Result with session ID, message count, and skip/error status.
 */
export async function ingestSessionMessages(
  sessionId: string,
  transcriptPath: string,
  vendor: 'claude' | 'codex',
  options?: IngestOptions,
): Promise<IngestResult> {
  // 1. Check if already processed (batch/backfill only — real-time always appends)
  //    When force is not set, we still proceed to INSERT OR IGNORE new messages.

  // 2. Load entries via vendor-dispatched reader on the given transcript path
  let rawEntries: TranscriptEntry[];
  try {
    if (vendor === 'claude') {
      const raw = parseJsonlFile(transcriptPath);
      rawEntries = adaptClaudeEntries(raw as unknown as Record<string, unknown>[]);
    } else {
      const envelopes = parseCodexJsonlFile(transcriptPath);
      rawEntries = adaptCodexJsonlRecords(envelopes, sessionId);
    }
  } catch (err) {
    return {
      sessionId,
      chunksCreated: 0,
      skipped: false,
      error: `Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (rawEntries.length === 0) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 3. Resolve project_id. The Stop hook passes the session cwd explicitly;
  //    backfill passes nothing, so fall back to the cwd recorded on the
  //    transcript's own entries (both Claude and Codex adapters carry it).
  //    Without this fallback every backfilled session lands with a NULL
  //    project_id and is invisible to project-scoped (default) recall search.
  const rawProjectId = options?.projectId ?? entriesCwd(rawEntries);
  const projectId = rawProjectId ? normalizePath(rawProjectId) : null;

  // 4. Strip tool content, filter sub-agent entries
  const filtered = stripToolContent(rawEntries);
  const topLevel = filtered.filter(e => !e.parentToolUseID);

  // 5. Extract text per entry, build MessageRecords
  const records: MessageRecord[] = [];

  for (let i = 0; i < topLevel.length; i++) {
    const entry = topLevel[i]!;

    // Skip entries without uuid — can't be the PK
    if (!entry.uuid) continue;

    const text = extractEntryText(entry);
    if (!text) continue;

    // Use conversation time from the entry when available, fall back to ingest time
    const createdAt = entry.timestamp
      ? new Date(entry.timestamp).getTime()
      : Date.now();

    records.push({
      message_id: entry.uuid,
      session_id: sessionId,
      message_seq: i,
      message_text: text,
      project_id: projectId,
      created_at: createdAt,
      message_role: entry.message?.role ?? entry.type ?? null,
    });
  }

  if (records.length === 0) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 6 & 7. Batch insert messages. When force is set, the session's existing
  // rows are cleared inside the SAME transaction as the insert (atomic replace)
  // so a crash can't leave the session transiently empty in the index.
  try {
    insertMessages(records, options?.force ? { replaceSessionId: sessionId } : undefined);
  } catch (err) {
    return {
      sessionId,
      chunksCreated: 0,
      skipped: false,
      error: `DB insert failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    sessionId,
    chunksCreated: records.length,
    skipped: false,
  };
}

// ============================================================================
// Semantic Embedding
// ============================================================================

/** Max characters to embed per message. Nomic's 8192 token context at ~1.9
 *  chars/token (worst case for dense code) = ~15,500 chars. 14,000 gives
 *  comfortable headroom (~7,400 tokens worst case). Exported so backfill
 *  scripts share the same limit — earlier versions had a stale 32K copy
 *  that produced >8192-token inputs on transcript-dense messages. */
export const MAX_EMBED_CHARS = 14_000;

/** Max messages to embed per call. Smaller batches give the parent more
 *  opportunities to check RSS between calls, limiting ONNX memory leak
 *  damage per IPC round-trip (~200ms/msg × 10 = 2s worst case).
 *  Backfill calls embedSessionMessages in a loop, so this doesn't limit
 *  total throughput — just per-call work. */
const MAX_EMBED_BATCH = 10;

/** Hard char cap for the per-item fallback. Each wordpiece token is ≥1 char, so
 *  chars ≤ tokens; 6,000 < the 8,192-token physical batch, so a slice this size
 *  ALWAYS fits and embeds. Used only when a normal MAX_EMBED_CHARS slice still
 *  exceeds the token budget (pathologically dense content — base64/minified
 *  JSON/hex) and 500s, so one poison message can't wedge the whole backfill. */
const SAFE_EMBED_CHARS = 6_000;

/**
 * Embed pre-truncated rows into vector records, resilient to a single oversized
 * message. Fast path embeds the whole batch in one call. If that throws — e.g.
 * one input exceeds the embed server's physical batch and the request 500s,
 * which would otherwise fail (and stall) every message behind it — fall back to
 * embedding each row alone, hard-truncating to SAFE_EMBED_CHARS any row that
 * still fails so it always yields a vector instead of blocking forever. Rows
 * that fail even then (transient: server down) are skipped and retried by the
 * next sweep.
 */
async function embedRowsResilient(
  rows: Array<{ messageId: string; text: string }>,
): Promise<MessageVectorRecord[]> {
  const { embedBatch } = await import('./embedder.js');
  const { quantizeToQ8, computeNorm } = await import('./quantize.js');

  // Prefix every document with DOC_PREFIX (nomic task instruction). Applied once
  // here so it survives both the whole-batch path and the SAFE_EMBED_CHARS
  // fallback slice (which slices from index 0, keeping the prefix at the front).
  // Only the embed *input* is prefixed; the stored message_text is untouched.
  rows = rows.map((r) => ({ messageId: r.messageId, text: DOC_PREFIX + r.text }));

  const toRecord = (messageId: string, f32: Float32Array): MessageVectorRecord => {
    const { q8, scale } = quantizeToQ8(f32);
    return { messageId, embeddingQ8: q8, norm: computeNorm(f32), quantScale: scale };
  };

  try {
    const vectors = await embedBatch(rows.map(r => r.text));
    return rows.map((r, j) => toRecord(r.messageId, vectors[j]!));
  } catch {
    const records: MessageVectorRecord[] = [];
    for (const r of rows) {
      try {
        const [v] = await embedBatch([r.text]);
        records.push(toRecord(r.messageId, v!));
      } catch {
        try {
          const [v] = await embedBatch([r.text.slice(0, SAFE_EMBED_CHARS)]);
          records.push(toRecord(r.messageId, v!));
        } catch (err) {
          log({
            source: 'recall:embed',
            level: 'warn',
            summary: `skipped message ${r.messageId} (embed failed even at ${SAFE_EMBED_CHARS} chars): ${(err as Error).message}`,
          });
        }
      }
    }
    return records;
  }
}

/**
 * Embed a session's indexed messages into q8 vectors for semantic search.
 *
 * Reads messages from the DB (must already be FTS5-indexed), embeds each
 * with Nomic Embed Code, quantizes to q8, and batch-inserts into
 * message_vectors. Only embeds messages that don't have vectors yet
 * (incremental), unless force is set to re-embed everything.
 *
 * The embedding model is lazy-loaded on first call (~2-10s). Subsequent
 * calls reuse the cached model (~200ms/msg on CPU).
 *
 * @param sessionId  The session to embed (must already have messages indexed).
 * @param force      Re-embed even if vectors already exist for this session.
 * @returns          Number of messages embedded, or 0 if skipped/failed.
 */
export async function embedSessionMessages(
  sessionId: string,
  force?: boolean,
): Promise<number> {
  const d = getDb(dbPath());

  // Only fetch messages that don't have vectors yet (unless force). The
  // correlated prev_text subquery fetches the immediately-preceding turn so
  // buildEmbedText can context-enrich short messages (embed input only).
  const rows = d.all(
    force
      ? `SELECT m.message_id, m.message_text,
           (SELECT p.message_text FROM messages p
             WHERE p.session_id = m.session_id AND p.message_seq < m.message_seq
             ORDER BY p.message_seq DESC LIMIT 1) AS prev_text
         FROM messages m WHERE m.session_id = ? ORDER BY m.message_seq ASC`
      : `SELECT m.message_id, m.message_text,
           (SELECT p.message_text FROM messages p
             WHERE p.session_id = m.session_id AND p.message_seq < m.message_seq
             ORDER BY p.message_seq DESC LIMIT 1) AS prev_text
         FROM messages m
         WHERE m.session_id = ?
           AND NOT EXISTS (SELECT 1 FROM message_vectors mv WHERE mv.message_id = m.message_id AND mv.embed_version = ?)
         ORDER BY m.message_seq ASC`,
    force ? [sessionId] : [sessionId, EMBED_VERSION],
  ) as Array<Record<string, unknown>>;

  const validRows: Array<{ messageId: string; text: string }> = [];
  for (const r of rows) {
    const messageText = (r.message_text as string).trim();
    if (!messageText) continue;
    const prevText = (r.prev_text as string) ?? null;
    const embedText = buildEmbedText(messageText, prevText);
    validRows.push({
      messageId: r.message_id as string,
      text: embedText.length > MAX_EMBED_CHARS ? embedText.slice(0, MAX_EMBED_CHARS) : embedText,
    });
  }
  if (validRows.length === 0) return 0;

  // Cap batch size to avoid memory spikes (rest catches up on next turn)
  if (validRows.length > MAX_EMBED_BATCH) {
    validRows.length = MAX_EMBED_BATCH;
  }

  // Embed (resilient: one oversized message can't fail the whole batch)
  const records = await embedRowsResilient(validRows);

  // Insert
  insertMessageVectors(records);
  return records.length;
}

/**
 * Embed a pre-fetched batch of messages (cross-session).
 *
 * Used by catch-up embedding to process messages from multiple sessions in a
 * single llama-embedding process spawn. Callers are responsible for fetching
 * messages (via getUnembeddedMessages) and managing concurrency.
 *
 * @param messages  Array of { message_id, message_text } to embed.
 * @returns         Number of messages successfully embedded.
 */
export async function embedMessageBatch(
  messages: Array<{ message_id: string; message_text: string; embed_text?: string }>,
): Promise<number> {
  if (messages.length === 0) return 0;

  const truncated: Array<{ messageId: string; text: string }> = [];
  for (const m of messages) {
    // Embed the context-enriched input when present (from getUnembeddedMessages
    // via buildEmbedText); fall back to raw message_text otherwise.
    const text = (m.embed_text ?? m.message_text).trim();
    if (!text) continue;
    truncated.push({
      messageId: m.message_id,
      text: text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text,
    });
  }
  if (truncated.length === 0) return 0;

  // Resilient embed: a single message that still exceeds the token budget after
  // truncation no longer 500s the whole batch (and stalls the backfill).
  const records = await embedRowsResilient(truncated);

  insertMessageVectors(records);
  return records.length;
}
