/** Per-process retry bounds and durable evidence for unattended embedding. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';

export interface EmbedFailure {
  updatedAt: string;
  attempts: number;
  reason: string;
  failedMessageIds: string[];
  /** Exhausted rows cool down across child restarts, then retry automatically. */
  retryAfter?: Record<string, number>;
}
const attempts = new Map<string, number>();
export const MAX_MESSAGE_ATTEMPTS = 3;
export function exhaustedEmbedMessageIds(): string[] {
  const durable = Object.entries(readEmbedFailure()?.retryAfter ?? {}).filter(([, until]) => until > Date.now()).map(([id]) => id);
  return [...new Set([...durable, ...[...attempts].filter(([, n]) => n >= MAX_MESSAGE_ATTEMPTS).map(([id]) => id)])];
}
export function readEmbedFailure(): EmbedFailure | null {
  try {
    const value = JSON.parse(readFileSync(join(logsDir(), 'embed-failure.json'), 'utf8'));
    if (!value || typeof value !== 'object' || typeof value.updatedAt !== 'string'
      || typeof value.reason !== 'string' || typeof value.attempts !== 'number'
      || !Array.isArray(value.failedMessageIds) || !value.failedMessageIds.every((id: unknown) => typeof id === 'string')) return null;
    if (value.retryAfter && (typeof value.retryAfter !== 'object' || Array.isArray(value.retryAfter)
      || !Object.values(value.retryAfter).every(n => typeof n === 'number' && Number.isFinite(n)))) return null;
    return value as EmbedFailure;
  }
  catch { return null; }
}
export function recordEmbedFailure(messageId: string, reason: string): void {
  attempts.set(messageId, (attempts.get(messageId) ?? 0) + 1);
  try {
    mkdirSync(logsDir(), { recursive: true });
    const previous = readEmbedFailure();
    const retryAfter = previous?.retryAfter ?? {};
    if (attempts.get(messageId)! >= MAX_MESSAGE_ATTEMPTS) retryAfter[messageId] = Date.now() + 15 * 60_000;
    writeFileSync(join(logsDir(), 'embed-failure.json'), JSON.stringify({
      updatedAt: new Date().toISOString(), attempts: attempts.get(messageId)!, reason,
      failedMessageIds: [...new Set([...(previous?.failedMessageIds ?? []), messageId])], retryAfter,
    } satisfies EmbedFailure));
  } catch { /* Diagnostics must not turn a failed embed into a failed ingest. */ }
}
export function recordEmbedSuccess(messageId: string): void {
  attempts.delete(messageId);
  try {
    const previous = readEmbedFailure();
    if (!previous) return;
    previous.failedMessageIds = previous.failedMessageIds.filter(id => id !== messageId);
    if (previous.retryAfter) delete previous.retryAfter[messageId];
    if (previous.failedMessageIds.length) writeFileSync(join(logsDir(), 'embed-failure.json'), JSON.stringify(previous));
    else rmSync(join(logsDir(), 'embed-failure.json'), { force: true });
  } catch { /* best effort */ }
}

/** An attended backfill explicitly retries rows after the backend is repaired. */
export function resetEmbedRetries(): void {
  attempts.clear();
  try {
    const previous = readEmbedFailure();
    if (previous) {
      delete previous.retryAfter;
      writeFileSync(join(logsDir(), 'embed-failure.json'), JSON.stringify(previous));
    }
  } catch { /* best effort */ }
}
