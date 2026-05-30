/**
 * settings-merge — JSON hook merge contract (§3).
 *
 * Verifies idempotent merge into hooks.Stop + hooks.SubagentStop, preservation
 * of existing entries / line endings / indentation, and stale-path auto-heal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeStopHook, removeStopHook } from '../../src/installer/settings-merge.js';

const HOOK = '/home/u/.recall/bin/stop-hook.js';
const CMD = `node ${HOOK}`;

let dir: string;
function setup(content: string, name = 'settings.json'): string {
  dir = mkdtempSync(join(tmpdir(), 'recall-merge-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

function recallEntries(arr: any[]): any[] {
  return (arr ?? []).filter((e) => e.hooks?.some((h: any) => /stop-hook\.js/.test(h.command) && /recall/.test(h.command)));
}

describe('settings-merge', () => {
  it('appends recall to Stop + SubagentStop, preserves existing entries + formatting', () => {
    const input = JSON.stringify({
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /other/hook.js' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }, null, 2);
    const p = setup(input);
    const r = mergeStopHook(p, HOOK);
    expect(r.changed).toBe(true);
    expect(r.backup).toBeTruthy();

    const out = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(out);

    // recall entry in BOTH arrays
    expect(recallEntries(parsed.hooks.Stop)).toHaveLength(1);
    expect(recallEntries(parsed.hooks.SubagentStop)).toHaveLength(1);
    expect(recallEntries(parsed.hooks.Stop)[0].hooks[0].command).toBe(CMD);
    // existing entries untouched
    expect(parsed.hooks.Stop.some((e: any) => e.hooks[0].command === 'node /other/hook.js')).toBe(true);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('echo hi');
    // 2-space indentation preserved
    expect(out).toContain('\n  "hooks"');
  });

  it('preserves CRLF line endings', () => {
    const input = JSON.stringify({ hooks: { Stop: [] } }, null, 2).replace(/\n/g, '\r\n');
    const p = setup(input);
    mergeStopHook(p, HOOK);
    const out = readFileSync(p, 'utf-8');
    expect(out.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it('is idempotent — second run is a no-op', () => {
    const p = setup(JSON.stringify({ hooks: { Stop: [] } }, null, 2));
    mergeStopHook(p, HOOK);
    const first = readFileSync(p, 'utf-8');
    const r2 = mergeStopHook(p, HOOK);
    expect(r2.changed).toBe(false);
    expect(readFileSync(p, 'utf-8')).toBe(first);
    const parsed = JSON.parse(first);
    expect(recallEntries(parsed.hooks.Stop)).toHaveLength(1);
  });

  it('auto-heals a stale recall path in place (no duplicate), creates SubagentStop', () => {
    const stale = 'node /old/path/.recall/bin/stop-hook.js';
    const p = setup(JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: stale }] }] },
    }, null, 2));
    mergeStopHook(p, HOOK);
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    // rewritten in place — still exactly one recall entry in Stop
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(CMD);
    // SubagentStop created with the recall entry alongside
    expect(recallEntries(parsed.hooks.SubagentStop)).toHaveLength(1);
  });

  it('uninstall removes recall entries (path-independent) and drops empty arrays', () => {
    const p = setup(JSON.stringify({
      hooks: {
        Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep' }] }],
      },
    }, null, 2));
    mergeStopHook(p, HOOK); // adds recall to Stop + SubagentStop
    const r = removeStopHook(p);
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(recallEntries(parsed.hooks.Stop ?? [])).toHaveLength(0);
    // non-recall entry survives; empty SubagentStop key dropped
    expect(parsed.hooks.Stop.some((e: any) => e.hooks[0].command === 'echo keep')).toBe(true);
    expect(parsed.hooks.SubagentStop).toBeUndefined();
  });
});
