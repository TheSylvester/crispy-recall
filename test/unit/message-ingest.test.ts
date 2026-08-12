import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { extractEntryText, ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { shouldDropAsMeta, META_KEEP_PREFIXES } from '../../src/recall/transcript-utils.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';
import type { TranscriptEntry } from '../../src/transcript.js';

// ============================================================================
// extractEntryText
// ============================================================================

describe('extractEntryText', () => {
  it('returns trimmed string content', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '  Hello world  ' },
    };
    expect(extractEntryText(entry)).toBe('Hello world');
  });

  it('joins array content text blocks with double newline', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('First block\n\nSecond block');
  });

  it('filters out non-text blocks from array content', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'Visible text' },
          { type: 'thinking', thinking: 'internal reasoning' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('Visible text');
  });

  it('returns empty string for entry without message', () => {
    const entry: TranscriptEntry = { type: 'user' };
    expect(extractEntryText(entry)).toBe('');
  });

  it('returns empty string for empty string content', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '' },
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('returns empty string for whitespace-only content', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '   \n  \t  ' },
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('returns empty string for array content with only non-text blocks', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('handles message with undefined content gracefully', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user' } as TranscriptEntry['message'],
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('trims whitespace from individual text blocks', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '  padded  ' },
          { type: 'text', text: '\n\ntrimmed\n\n' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('padded\n\ntrimmed');
  });

  it('skips text blocks with empty text after trim', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '   ' },
          { type: 'text', text: 'Real text' },
          { type: 'text', text: '' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('Real text');
  });
});

// ============================================================================
// shouldDropAsMeta
// ============================================================================

describe('shouldDropAsMeta', () => {
  it('drops a flagged skill injection', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'Base directory for this skill: /home/u/.claude/skills/recall' },
    };
    expect(shouldDropAsMeta(entry)).toBe(true);
  });

  it('keeps every META_KEEP_PREFIXES entry despite isMeta', () => {
    for (const prefix of META_KEEP_PREFIXES) {
      const entry: TranscriptEntry = {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: `${prefix} — dense background-agent findings` },
      };
      expect(shouldDropAsMeta(entry)).toBe(false);
    }
  });

  it('never drops entries without isMeta', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>' },
    };
    expect(shouldDropAsMeta(entry)).toBe(false);
  });

  it('checks the first TEXT block of array content for the whitelist', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'abc' } },
          { type: 'text', text: '<task-notification>agent done</task-notification>' },
        ],
      },
    };
    expect(shouldDropAsMeta(entry)).toBe(false);
  });

  it('is safe on entries without message or content (Phase 2 calls it pre-strip)', () => {
    expect(shouldDropAsMeta({ type: 'user', isMeta: true })).toBe(true);
    expect(shouldDropAsMeta({ type: 'summary', summary: 'a summary' })).toBe(false);
    expect(shouldDropAsMeta({
      type: 'user',
      isMeta: true,
      message: { role: 'user' } as TranscriptEntry['message'],
    })).toBe(true);
  });
});

// ============================================================================
// Meta filter — claude ingest end-to-end
// ============================================================================

describe('meta filter (claude ingest)', () => {
  let recallHome: string;
  let restoreRoot: () => void;
  const SID = randomUUID();

  beforeAll(() => {
    recallHome = join(tmpdir(), `recall-metafilter-${randomUUID()}`);
    mkdirSync(recallHome, { recursive: true });
    restoreRoot = _setTestRoot(recallHome);
    _resetDb();
    getDb(dbPath());
  });

  afterAll(() => {
    restoreRoot?.();
    _resetDb();
    if (recallHome && existsSync(recallHome)) rmSync(recallHome, { recursive: true, force: true });
  });

  it('drops boilerplate but keeps prompts, task notifications, and agent messages', async () => {
    const base = { sessionId: SID, cwd: '/home/u/proj' };
    const user = (uuid: string, text: string, extra?: Record<string, unknown>) => ({
      type: 'user', uuid, timestamp: '2026-08-10T12:00:00.000Z', ...base,
      message: { role: 'user', content: text }, ...extra,
    });
    const lines = [
      user('u-prompt', 'Please add the meta filter to ingest'),
      // Skill injection: explicit isMeta flag (2.1.x reality)
      user('u-skill', 'Base directory for this skill: /home/u/.claude/skills/recall', { isMeta: true }),
      // Slash-command plumbing: NO explicit flag — heuristic path only
      user('u-cmd', '<command-name>/model</command-name>\n<command-args>opus</command-args>'),
      user('u-stdout', '<local-command-stdout>Set model to opus</local-command-stdout>'),
      user('u-caveat', '<local-command-caveat>Caveat: the messages below were generated…</local-command-caveat>'),
      // Whitelisted meta: real signal, must survive
      user('u-task', '<task-notification>Agent found the root cause in db.ts</task-notification>', { isMeta: true }),
      user('u-xsession', 'Another Claude session sent a message: the fix is on branch feat/x', { isMeta: true }),
      {
        type: 'assistant', uuid: 'a-reply', timestamp: '2026-08-10T12:00:01.000Z', ...base,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Filter added.' }] },
      },
    ];
    const jsonlPath = join(recallHome, `${SID}.jsonl`);
    writeFileSync(jsonlPath, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const res = await ingestSessionMessages(SID, jsonlPath, 'claude');
    expect(res.error).toBeUndefined();

    const rows = getDb(dbPath()).all(
      'SELECT message_id FROM messages WHERE session_id = ? ORDER BY message_seq',
      [res.sessionId],
    ) as Array<{ message_id: string }>;

    expect(rows.map((r) => r.message_id)).toEqual([
      'u-prompt', 'u-task', 'u-xsession', 'a-reply',
    ]);
  });
});
