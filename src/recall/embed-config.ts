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
/** 1 = legacy bare (pre-prefix) vectors. Current = 2 (prefixed). */
export const EMBED_VERSION = 2;
