/**
 * Log — stderr-only structured logger
 *
 * Minimal stderr logger. Uses the `log({level, source, summary, data})`
 * shape so existing call sites don't need changes.
 * Level gating via RECALL_LOG_LEVEL env var (default: 'info').
 *
 * @module log
 */

export interface LogEntry {
  source: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  summary: string;
  data?: unknown;
}

const LEVEL_ORDER: Record<LogEntry['level'], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const _rawEnvLevel = process.env['RECALL_LOG_LEVEL']?.toLowerCase();
const _thresholdLevel: LogEntry['level'] =
  _rawEnvLevel === 'debug' || _rawEnvLevel === 'info' || _rawEnvLevel === 'warn' || _rawEnvLevel === 'error'
    ? _rawEnvLevel
    : 'info';
const _threshold = LEVEL_ORDER[_thresholdLevel];

/** Write a log entry to stderr. Below-threshold entries are dropped. */
export function log(entry: LogEntry): void {
  if (LEVEL_ORDER[entry.level] < _threshold) return;
  const line = `[${entry.level}] ${entry.source}: ${entry.summary}`;
  if (entry.data !== undefined) {
    try {
      process.stderr.write(`${line} ${JSON.stringify(entry.data)}\n`);
    } catch {
      process.stderr.write(`${line}\n`);
    }
  } else {
    process.stderr.write(`${line}\n`);
  }
}
