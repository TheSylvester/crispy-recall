/**
 * Embedding representation config — task prefixes + version stamp.
 *
 * nomic-embed-text-v1.5 requires task-instruction prefixes: documents are
 * embedded with DOC_PREFIX, queries with QUERY_PREFIX. EMBED_VERSION stamps
 * every stored vector; bump it whenever the embedding *input* representation
 * changes (model, prefix, pooling) so stale-version vectors are transparently
 * re-embedded by the normal sweep and excluded from scoring until then.
 *
 * Kept in its own dependency-free module so the store, ingest, and query
 * modules share one source of truth and the doc/query prefixes can never drift.
 */
export const DOC_PREFIX = 'search_document: ';
export const QUERY_PREFIX = 'search_query: ';
/**
 * 1 = legacy bare (pre-prefix) vectors. 2 = prefixed. Current = 3 (prefixed +
 * adjacency context-enriched embed input). Bumped whenever the embed *input*
 * representation changes so stale-version vectors are transparently re-embedded.
 */
export const EMBED_VERSION = 3;

/** Messages shorter than this get adjacency context prepended to their embed input. */
export const ENRICH_MAX_CHARS = 200;
/** Max chars of preceding-turn context to prepend. */
export const ENRICH_PREV_CHARS = 512;
/** Separator between prepended context and the message's own text. */
export const ENRICH_SEP = '\n';

/** Build the embed INPUT for a message: prepend bounded preceding-turn context for
 *  short messages; long messages embed as-is. Never mutates stored/FTS text. */
export function buildEmbedText(messageText: string, prevText: string | null): string {
  if (messageText.length >= ENRICH_MAX_CHARS || !prevText) return messageText;
  return prevText.slice(-ENRICH_PREV_CHARS) + ENRICH_SEP + messageText;
}
