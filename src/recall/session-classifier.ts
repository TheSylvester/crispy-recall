/**
 * Session Classifier — decides, at ingest time, whether a transcript is a
 * canonical ROOT thread (retrieval class 'hot') or a subagent LEAF
 * ('agent': durable and explicitly readable, but excluded from default
 * retrieval and embedding).
 *
 * Classification is evidence-based, never just `session_id.startsWith(...)`:
 *
 *   1. STORED provenance — the session_provenance table maps a transcript
 *      path to its canonical session id + kind, so a Stop-hook ingest and a
 *      later T1/mtime scan of the SAME file resolve to ONE identity (no
 *      duplicate Codex children under hook agent_id vs rollout UUID).
 *   2. EXPLICIT hook evidence — SubagentStop / agent_transcript_path.
 *   3. CLAUDE path layout — `<parent-uuid>/subagents/agent-*.jsonl`.
 *   4. CLAUDE leaf naming — an `agent-*` transcript basename.
 *   5. CODEX session_meta — `payload.source.subagent.thread_spawn` (parent
 *      thread id, depth, agent path/type), parsed defensively.
 *
 * The CANONICAL id for a Codex child is the transcript's own session-meta
 * UUID (falling back to the rollout filename UUID) — NEVER the hook's
 * `agent_id`, which is preserved as an alias. A child whose canonical id
 * cannot be derived at all is skipped conservatively (`unresolvable`), never
 * stapled onto the parent id.
 *
 * Unknown or malformed provenance is handled conservatively (root/hot) and
 * logged — ambiguous sessions are never guessed cold.
 *
 * @module recall/session-classifier
 */

import { getDb } from '../db.js';
import { dbPath } from '../paths.js';
import { log } from '../log.js';
import { extractCodexSessionMeta } from '../adapters/codex/codex-jsonl-reader.js';

// ============================================================================
// Types
// ============================================================================

/** Hook-supplied evidence forwarded by the Stop hook (absent for T1/scan). */
export interface HookContext {
  /** The Stop payload's session_id — the PARENT for a SubagentStop. */
  payloadSessionId?: string;
  /** payload.agent_id — an alias, never the canonical child id. */
  agentId?: string;
  /** True when agent_transcript_path was present (SubagentStop shape). */
  isSubagent?: boolean;
}

export interface SessionClassification {
  kind: 'root' | 'agent';
  canonicalSessionId: string;
  parentSessionId: string | null;
  agentDepth: number | null;
  /** Bounded JSON-able bag of agent metadata (path/type/source), when known. */
  agentMeta: Record<string, unknown> | null;
  /** Alternate identifiers that must resolve to the canonical id. */
  aliases: string[];
  /** Which evidence decided the classification (logging/tests). */
  evidence: 'stored' | 'hook' | 'claude-path' | 'claude-name' | 'codex-meta' | 'default-root';
  /** Set when a child is known to be a subagent but no canonical id can be
   *  derived — callers must SKIP the ingest, never guess. */
  unresolvable?: boolean;
}

export interface ClassifyArgs {
  /** Caller's proposed session id (hook payload / filename-derived). */
  sessionId: string;
  transcriptPath: string;
  vendor: 'claude' | 'codex';
  hook?: HookContext;
}

// ============================================================================
// Helpers
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_UUID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function basenameNoExt(p: string): string {
  return normalize(p).split('/').pop()!.replace(/\.jsonl$/i, '');
}

/** Stored provenance lookup by transcript path. Tolerates a missing table
 *  (pre-migration DB in installer contexts). */
function lookupStoredProvenance(transcriptPath: string): {
  session_id: string; kind: string; parent_session_id: string | null;
} | null {
  try {
    const row = getDb(dbPath()).get(
      `SELECT session_id, kind, parent_session_id FROM session_provenance
       WHERE transcript_path = ? LIMIT 1`,
      [normalize(transcriptPath)],
    ) as { session_id: string; kind: string; parent_session_id: string | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Extract the parent session UUID from `<parent>/subagents/agent-*.jsonl`. */
function claudeSubagentParent(normPath: string): string | null {
  const segments = normPath.split('/');
  const idx = segments.lastIndexOf('subagents');
  if (idx <= 0) return null;
  const parent = segments[idx - 1]!;
  return parent || null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Classify a session for ingest. Pure evidence evaluation plus one stored-
 * provenance DB read; never mutates anything (persistence happens inside the
 * ingest transaction).
 */
export function classifySession(args: ClassifyArgs): SessionClassification {
  const { sessionId, transcriptPath, vendor, hook } = args;
  const normPath = normalize(transcriptPath);
  const base = basenameNoExt(transcriptPath);

  // 1. Stored provenance: a path already resolved to a canonical identity
  //    keeps that identity across hooks and later mtime scans. One exception:
  //    a stored 'root' inferred by default (e.g. a T1 scan that saw no
  //    subagent metadata) is UPGRADED by explicit SubagentStop evidence —
  //    fall through to vendor classification so the leaf goes cold. The
  //    reverse (stored 'agent' + rootish evidence) never downgrades.
  const stored = lookupStoredProvenance(transcriptPath);
  if (stored && !(stored.kind !== 'agent' && hook?.isSubagent)) {
    return {
      kind: stored.kind === 'agent' ? 'agent' : 'root',
      canonicalSessionId: stored.session_id,
      parentSessionId: stored.parent_session_id,
      agentDepth: null,
      agentMeta: null,
      aliases: aliasCandidates(stored.session_id, sessionId, hook),
      evidence: 'stored',
    };
  }

  if (vendor === 'claude') return classifyClaude(sessionId, normPath, base, hook);
  return classifyCodex(sessionId, transcriptPath, base, hook);
}

function aliasCandidates(
  canonical: string,
  proposed: string,
  hook?: HookContext,
): string[] {
  const out = new Set<string>();
  if (hook?.agentId && hook.agentId !== canonical) out.add(hook.agentId);
  if (proposed && proposed !== canonical) out.add(proposed);
  return [...out];
}

// ----------------------------------------------------------------------------
// Claude
// ----------------------------------------------------------------------------

function classifyClaude(
  sessionId: string,
  normPath: string,
  base: string,
  hook?: HookContext,
): SessionClassification {
  // Path layout: <parent-uuid>/subagents/agent-*.jsonl
  if (normPath.includes('/subagents/') && base.startsWith('agent-')) {
    return {
      kind: 'agent',
      canonicalSessionId: base,
      parentSessionId: claudeSubagentParent(normPath) ?? hook?.payloadSessionId ?? null,
      agentDepth: null,
      agentMeta: hook?.agentId ? { hookAgentId: hook.agentId } : null,
      aliases: aliasCandidates(base, sessionId, hook),
      evidence: 'claude-path',
    };
  }

  // Leaf naming without the layout (moved/copied transcript, custom dirs).
  if (base.startsWith('agent-') || sessionId.startsWith('agent-')) {
    const canonical = base.startsWith('agent-') ? base : sessionId;
    return {
      kind: 'agent',
      canonicalSessionId: canonical,
      parentSessionId: hook?.payloadSessionId ?? null,
      agentDepth: null,
      agentMeta: hook?.agentId ? { hookAgentId: hook.agentId } : null,
      aliases: aliasCandidates(canonical, sessionId, hook),
      evidence: 'claude-name',
    };
  }

  // Explicit SubagentStop without a recognizable leaf shape: still a leaf.
  if (hook?.isSubagent) {
    return {
      kind: 'agent',
      canonicalSessionId: base || sessionId,
      parentSessionId: hook.payloadSessionId ?? null,
      agentDepth: null,
      agentMeta: hook.agentId ? { hookAgentId: hook.agentId } : null,
      aliases: aliasCandidates(base || sessionId, sessionId, hook),
      evidence: 'hook',
    };
  }

  return {
    kind: 'root',
    canonicalSessionId: sessionId,
    parentSessionId: null,
    agentDepth: null,
    agentMeta: null,
    aliases: [],
    evidence: 'default-root',
  };
}

// ----------------------------------------------------------------------------
// Codex
// ----------------------------------------------------------------------------

function classifyCodex(
  sessionId: string,
  transcriptPath: string,
  base: string,
  hook?: HookContext,
): SessionClassification {
  const meta = extractCodexSessionMeta(transcriptPath);

  // Canonical Codex identity: the transcript's OWN session-meta UUID, then
  // the rollout filename UUID. NEVER the hook agent_id.
  const filenameUuid = ROLLOUT_UUID_RE.exec(normalize(transcriptPath))?.[1] ?? null;
  const canonical = (meta?.id && typeof meta.id === 'string' && meta.id.length > 0)
    ? meta.id
    : filenameUuid ?? (UUID_RE.test(sessionId) ? sessionId : null);

  // Subagent evidence from session_meta.source (defensively parsed).
  const sub = parseSubagentSource(meta?.source, transcriptPath);

  if (sub.malformed) {
    log({
      source: 'recall:classify',
      level: 'warn',
      summary: `codex session_meta.source looks subagent-like but is malformed — leaving session hot (conservative): ${transcriptPath}`,
    });
  }

  if (sub.isSubagent || hook?.isSubagent) {
    if (!canonical) {
      // A known child with no derivable identity: skip, never guess and never
      // staple onto the parent id.
      log({
        source: 'recall:classify',
        level: 'warn',
        summary: `codex subagent transcript has no derivable canonical id — skipping ingest (conservative): ${transcriptPath}`,
      });
      return {
        kind: 'agent',
        canonicalSessionId: base || sessionId,
        parentSessionId: sub.parentThreadId ?? hook?.payloadSessionId ?? null,
        agentDepth: sub.depth,
        agentMeta: sub.meta,
        aliases: [],
        evidence: sub.isSubagent ? 'codex-meta' : 'hook',
        unresolvable: true,
      };
    }
    return {
      kind: 'agent',
      canonicalSessionId: canonical,
      parentSessionId: sub.parentThreadId ?? hook?.payloadSessionId ?? null,
      agentDepth: sub.depth,
      agentMeta: mergeMeta(sub.meta, hook?.agentId),
      aliases: aliasCandidates(canonical, sessionId, hook),
      evidence: sub.isSubagent ? 'codex-meta' : 'hook',
    };
  }

  return {
    kind: 'root',
    canonicalSessionId: canonical ?? sessionId,
    parentSessionId: null,
    agentDepth: null,
    agentMeta: null,
    aliases: canonical && canonical !== sessionId ? [sessionId] : [],
    evidence: 'default-root',
  };
}

function mergeMeta(
  meta: Record<string, unknown> | null,
  hookAgentId?: string,
): Record<string, unknown> | null {
  if (!hookAgentId) return meta;
  return { ...(meta ?? {}), hookAgentId };
}

interface SubagentSource {
  isSubagent: boolean;
  malformed: boolean;
  parentThreadId: string | null;
  depth: number | null;
  meta: Record<string, unknown> | null;
}

/**
 * Parse `session_meta.payload.source` defensively. Recognized child shapes:
 *   - `source.subagent.thread_spawn: { parent_thread_id, depth, … }`
 *   - `source.type === 'subagent'` with the same nested fields
 * Anything subagent-like but non-object → malformed (conservative root).
 */
function parseSubagentSource(
  source: Record<string, unknown> | undefined,
  _transcriptPath: string,
): SubagentSource {
  const none: SubagentSource = { isSubagent: false, malformed: false, parentThreadId: null, depth: null, meta: null };
  if (!source || typeof source !== 'object') return none;

  const subRaw = (source as { subagent?: unknown }).subagent;
  const typeTag = (source as { type?: unknown }).type;
  const looksSubagent = subRaw !== undefined || typeTag === 'subagent';
  if (!looksSubagent) return none;

  if (subRaw !== undefined && (typeof subRaw !== 'object' || subRaw === null)) {
    return { ...none, malformed: true };
  }

  const sub = (subRaw ?? {}) as Record<string, unknown>;
  const spawnRaw = sub.thread_spawn ?? (source as Record<string, unknown>).thread_spawn;
  const spawn = (spawnRaw && typeof spawnRaw === 'object') ? spawnRaw as Record<string, unknown> : {};

  const parentThreadId = typeof spawn.parent_thread_id === 'string' && spawn.parent_thread_id
    ? spawn.parent_thread_id
    : null;
  const depth = typeof spawn.depth === 'number' && Number.isFinite(spawn.depth)
    ? spawn.depth
    : null;

  // Bounded metadata bag: keep the interesting scalar fields only.
  const meta: Record<string, unknown> = {};
  for (const k of ['agent_path', 'agent_type', 'agent_name', 'path', 'type', 'name']) {
    const v = spawn[k] ?? sub[k];
    if (typeof v === 'string' || typeof v === 'number') meta[k] = v;
  }

  return {
    isSubagent: true,
    malformed: false,
    parentThreadId,
    depth,
    meta: Object.keys(meta).length > 0 ? meta : null,
  };
}
