/**
 * Codex path coverage — previously untested end-to-end.
 *
 * Three concerns:
 *  1. adaptCodexJsonlRecords — envelope → TranscriptEntry mapping: user/assistant
 *     text, reasoning→thinking, exec_command function_call + output pairing
 *     (exit-code header parse), and developer-message skipping.
 *  2. ingestSessionMessages(..., 'codex') — the full reader→adapter→store path
 *     lands exactly the user/assistant TEXT messages (tool + developer stripped).
 *  3. mergeStopHook/removeStopHook on a ~/.codex/hooks.json — the SAME merge the
 *     installer reuses for Codex; must add recall without clobbering a user's
 *     existing hook, and reverse cleanly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { adaptCodexJsonlRecords } from '../../src/adapters/codex/codex-jsonl-adapter.js';
import { vendorForTranscript } from '../../src/hooks/stop-hook.js';
import { ingestSessionMessages } from '../../src/recall/message-ingest.js';
import { mergeStopHook, removeStopHook } from '../../src/installer/settings-merge.js';
import { _setTestRoot, dbPath } from '../../src/paths.js';
import { _resetDb, getDb } from '../../src/db.js';

const SID = '019c3ae2-9a7f-7f30-9717-d3ccfb7bac63';

/** A representative Codex rollout transcript as envelope records. */
function codexEnvelopes(): Array<Record<string, unknown>> {
  return [
    { timestamp: '2026-02-07T20:34:15.000Z', type: 'session_meta', payload: { id: SID, cwd: '/home/u/proj', cli_version: '0.92.0' } },
    { timestamp: '2026-02-07T20:34:16.000Z', type: 'turn_context', payload: { cwd: '/home/u/proj', model: 'gpt-5-codex' } },
    { timestamp: '2026-02-07T20:34:17.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please fix the failing test in utils.ts' }] } },
    { timestamp: '2026-02-07T20:34:18.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'The test fails due to an off-by-one error.' }] } },
    { timestamp: '2026-02-07T20:34:19.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }) } },
    { timestamp: '2026-02-07T20:34:20.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 0\nOutput:\nAll tests passed' } },
    { timestamp: '2026-02-07T20:34:21.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the off-by-one; tests pass now.' }] } },
    { timestamp: '2026-02-07T20:34:22.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'internal system reminder' }] } },
  ];
}

function textOf(entry: any): string {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return '';
}

describe('codex JSONL adapter', () => {
  it('maps user/assistant/reasoning/function_call and skips developer', () => {
    const entries = adaptCodexJsonlRecords(codexEnvelopes() as any, SID) as any[];

    const user = entries.find((e) => e.type === 'user');
    expect(user).toBeDefined();
    expect(textOf(user)).toContain('Please fix the failing test');

    const assistantText = entries.find((e) => e.type === 'assistant' && textOf(e).includes('Fixed the off-by-one'));
    expect(assistantText).toBeDefined();
    expect(assistantText.message.model).toBe('gpt-5-codex');

    // reasoning → assistant entry carrying a thinking block
    const reasoning = entries.find((e) =>
      Array.isArray(e?.message?.content) && e.message.content.some((b: any) => b.type === 'thinking'),
    );
    expect(reasoning).toBeDefined();

    // exec_command → Bash tool_use, paired with its output as a result entry
    const toolCall = entries.find((e) => e.uuid === 'call_1');
    expect(toolCall).toBeDefined();
    const toolUse = toolCall.message.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.name).toBe('Bash');
    expect(toolUse.input.command).toBe('npm test');

    const result = entries.find((e) => e.type === 'result' && e.uuid === 'call_1-result');
    expect(result).toBeDefined();
    expect(result.toolUseResult.exitCode).toBe(0);

    // developer message must NOT appear anywhere
    expect(entries.some((e) => textOf(e).includes('internal system reminder'))).toBe(false);
  });

  // Regression: a function_call_output whose `output` is an ARRAY of content
  // items (image/tool results, e.g. screenshots) must NOT crash the adapter.
  // The declared `output: string` type is a lie at runtime for these; calling
  // .match()/JSON.parse() on the array threw `output.match is not a function`,
  // aborting the whole session ingest and pinning the watermark forever.
  it('handles array-valued function_call_output (image result) without throwing', () => {
    const envelopes: Array<Record<string, unknown>> = [
      { timestamp: '2026-04-17T14:02:52.000Z', type: 'session_meta', payload: { id: SID, cwd: '/home/u/proj', cli_version: '0.92.0' } },
      { timestamp: '2026-04-17T14:02:53.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'screenshot the page' }] } },
      { timestamp: '2026-04-17T14:02:54.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call_img', name: 'browser_screenshot', arguments: '{}' } },
      // output is an ARRAY, not a string — the crash trigger:
      { timestamp: '2026-04-17T14:02:55.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_img', output: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] } },
      { timestamp: '2026-04-17T14:02:56.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here is the screenshot.' }] } },
    ];

    let entries: any[] = [];
    expect(() => { entries = adaptCodexJsonlRecords(envelopes as any, SID) as any[]; }).not.toThrow();

    // The session still ingests: user + assistant text survive.
    expect(entries.some((e) => textOf(e).includes('screenshot the page'))).toBe(true);
    expect(entries.some((e) => textOf(e).includes('Here is the screenshot'))).toBe(true);
    // The image tool result maps to an empty (non-crashing) body.
    const result = entries.find((e) => e.type === 'result' && e.uuid === 'call_img-result');
    expect(result).toBeDefined();
  });
});

describe('codex vendor detection (stop-hook path classification)', () => {
  it('routes a POSIX .codex transcript to codex', () => {
    expect(vendorForTranscript('/home/u/.codex/sessions/2026/rollout.jsonl')).toBe('codex');
  });

  it('routes a Windows-native backslash .codex transcript to codex', () => {
    // On Windows-native the harness supplies backslash paths; the substring
    // test must normalize separators or every Codex session misroutes to claude.
    expect(vendorForTranscript('C:\\Users\\u\\.codex\\sessions\\2026\\rollout.jsonl')).toBe('codex');
  });

  it('routes a non-codex transcript to claude', () => {
    expect(vendorForTranscript('C:\\Users\\u\\.claude\\projects\\p\\sess.jsonl')).toBe('claude');
    expect(vendorForTranscript('/home/u/.claude/projects/p/sess.jsonl')).toBe('claude');
  });
});

describe('codex ingest (reader → adapter → store)', () => {
  let recallHome: string;
  let restoreRoot: () => void;

  beforeAll(() => {
    recallHome = join(tmpdir(), `recall-codex-${randomUUID()}`);
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

  it('ingests only the user/assistant text messages from a codex transcript', async () => {
    const jsonlPath = join(recallHome, `rollout-2026-02-07T20-34-15-${SID}.jsonl`);
    writeFileSync(jsonlPath, codexEnvelopes().map((e) => JSON.stringify(e)).join('\n') + '\n');

    const res = await ingestSessionMessages('codex-sess-1', jsonlPath, 'codex');
    expect(res.error).toBeUndefined();

    const rows = getDb(dbPath()).all(
      'SELECT message_text, message_role FROM messages WHERE session_id = ? ORDER BY message_seq',
      ['codex-sess-1'],
    ) as Array<{ message_text: string; message_role: string }>;

    // Exactly the two text turns — tool call/result + developer + reasoning stripped.
    expect(rows).toHaveLength(2);
    const texts = rows.map((r) => r.message_text).join('\n');
    expect(texts).toContain('Please fix the failing test');
    expect(texts).toContain('Fixed the off-by-one');
    expect(texts).not.toContain('internal system reminder');
    expect(texts).not.toContain('npm test'); // tool content stripped
    expect(rows.map((r) => r.message_role).sort()).toEqual(['assistant', 'user']);
  });
});

describe('codex hooks.json merge / unmerge', () => {
  let dir: string;
  let hooksPath: string;
  const RECALL_HOOK = '/home/u/.recall/bin/stop-hook.js';

  beforeAll(() => {
    dir = join(tmpdir(), `recall-codexhooks-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    hooksPath = join(dir, 'hooks.json');
  });

  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds recall to Stop + SubagentStop, preserves a user hook, and is idempotent', () => {
    // A user's own pre-existing codex Stop hook.
    writeFileSync(hooksPath, JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/bin/my-own-hook.sh' }] }] },
    }, null, 2));

    const r1 = mergeStopHook(hooksPath, RECALL_HOOK);
    expect(r1.changed).toBe(true);

    const obj = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const stopCmds = obj.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain('/usr/bin/my-own-hook.sh');          // user hook preserved
    expect(stopCmds.some((c: string) => c.includes('stop-hook.js'))).toBe(true); // recall added
    const subCmds = obj.hooks.SubagentStop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(subCmds.some((c: string) => c.includes('stop-hook.js'))).toBe(true);

    // Re-merge is a no-op.
    expect(mergeStopHook(hooksPath, RECALL_HOOK).changed).toBe(false);
  });

  it('removeStopHook reverses cleanly, leaving the user hook intact', () => {
    const r = removeStopHook(hooksPath);
    expect(r.changed).toBe(true);

    const obj = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const stopCmds = obj.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(stopCmds).toEqual(['/usr/bin/my-own-hook.sh']);   // only the user hook remains
    expect(obj.hooks.SubagentStop).toBeUndefined();           // emptied array dropped
  });
});
