/**
 * settings-merge — JSON hook merge contract (§3).
 *
 * Verifies idempotent merge into hooks.Stop + hooks.SubagentStop, preservation
 * of existing entries / line endings / indentation, and stale-path auto-heal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeStopHook, removeStopHook } from '../../src/installer/settings-merge.js';

const HOOK = '/home/u/.recall/bin/stop-hook.js';
// The hook command pins the installing Node's execPath (ABI-lock survival) and
// quotes both paths — see settings-merge.ts mergeStopHook.
const CMD = `"${process.execPath}" "${HOOK}"`;

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

  it('writes atomically — correct content and no leftover *.tmp.* file', () => {
    const p = setup(JSON.stringify({ hooks: { Stop: [] } }, null, 2));
    const r = mergeStopHook(p, HOOK);
    expect(r.changed).toBe(true);

    // (a) target content is valid + correct
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(recallEntries(parsed.hooks.Stop)).toHaveLength(1);
    expect(recallEntries(parsed.hooks.SubagentStop)).toHaveLength(1);
    expect(recallEntries(parsed.hooks.Stop)[0].hooks[0].command).toBe(CMD);

    // (b) the write-to-temp-then-rename left no temp file behind
    const leftovers = readdirSync(dir).filter((f) => /\.tmp\./.test(f));
    expect(leftovers).toEqual([]);
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

describe('hook ownership and grouped entries', () => {
  it.each(['settings.json', 'hooks.json'])('preserves command and prompt siblings through quiesce/remerge in %s', (name) => {
    const foreign = [{ type: 'command', command: 'echo keep', timeout: 17 }, { type: 'prompt', prompt: 'Review the result' }];
    const entry = { matcher: 'custom', timeout: 91, hooks: [{ type: 'command', command: CMD }, ...foreign] };
    const p = setup(JSON.stringify({ hooks: { Stop: [entry], SubagentStop: [entry] } }), name);
    const result = removeStopHook(p);
    expect(existsSync(result.backup!)).toBe(true);
    for (const entries of Object.values(JSON.parse(readFileSync(p, 'utf8')).hooks) as any[]) {
      expect(entries).toEqual([{ ...entry, hooks: foreign }]);
    }
    mergeStopHook(p, HOOK);
    removeStopHook(p);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop).toEqual([{ ...entry, hooks: foreign }]);
  });

  it.each([
    `sh -c 'notify; ${CMD}'`, `${CMD} && notify`, `${CMD} --custom`,
    'node /home/u/not-recall/stop-hook.js', 'node /home/u/backups.recall/stop-hook.js',
    `"echo" "${HOOK}"`,
  ])('never claims a foreign wrapper or lookalike: %s', (command) => {
    const entry = { matcher: '', hooks: [{ type: 'command', command }] };
    const p = setup(JSON.stringify({ hooks: { Stop: [entry] } }));
    expect(removeStopHook(p).changed).toBe(false);
    mergeStopHook(p, HOOK);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop[0]).toEqual(entry);
    removeStopHook(p);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop).toEqual([entry]);
  });

  // A wrapper we do not own is still an invocation that RUNS, so adding our
  // own entry beside it fires the hook twice per turn. That duplicate is an
  // ACCEPTED limitation: shell text cannot be judged by substring, and the
  // alternative (suppressing the install on a path mention) silently leaves a
  // machine without ingestion — see the mention cases below.
  it.each([
    `sh -c 'my-notify; ${CMD}'`,
    `${CMD} && my-notify`,
  ])('adds the recall entry beside a wrapper running the same invocation (accepted duplicate): %s', (command) => {
    const entry = { matcher: '', hooks: [{ type: 'command', command }] };
    const p = setup(JSON.stringify({ hooks: { Stop: [entry], SubagentStop: [entry] } }));
    expect(mergeStopHook(p, HOOK).changed).toBe(true);
    const hooks = JSON.parse(readFileSync(p, 'utf8')).hooks;
    for (const name of ['Stop', 'SubagentStop']) {
      expect(hooks[name]).toHaveLength(2);
      expect(hooks[name][0]).toEqual(entry);
      expect(hooks[name][1].hooks[0].command).toBe(CMD);
    }
    // Still not ours: removal takes only our direct entry and leaves the wrapper.
    expect(removeStopHook(p).changed).toBe(true);
    const after = JSON.parse(readFileSync(p, 'utf8')).hooks;
    expect(after.Stop).toEqual([entry]);
    expect(after.SubagentStop).toEqual([entry]);
  });

  // Commands that merely MENTION both paths run nothing of ours. A substring
  // match once treated them as "already installed" and skipped the install.
  it.each([
    [`echo '${CMD}'`, 'an echo of the command'],
    [`echo ok # ${CMD}`, 'a comment naming the command'],
    [`"${process.execPath}" "${HOOK}.bak"`, 'a different script whose name has the hook path as a prefix'],
    [`node -e "console.log(process.argv)" -- "${process.execPath}" "${HOOK}"`, 'the paths as arguments to another program'],
  ])('installs the recall entry beside %s (%s)', (command) => {
    const entry = { matcher: '', hooks: [{ type: 'command', command }] };
    const p = setup(JSON.stringify({ hooks: { Stop: [entry], SubagentStop: [entry] } }));
    expect(mergeStopHook(p, HOOK).changed).toBe(true);
    const hooks = JSON.parse(readFileSync(p, 'utf8')).hooks;
    for (const name of ['Stop', 'SubagentStop']) {
      expect(hooks[name]).toHaveLength(2);
      expect(hooks[name][0]).toEqual(entry);
      expect(hooks[name][1].hooks[0].command).toBe(CMD);
    }
    // Idempotent on a second merge: exactly one recall entry, the mention untouched.
    expect(mergeStopHook(p, HOOK).changed).toBe(false);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop).toHaveLength(2);
    // Never claimed: removal deletes only our direct entry.
    removeStopHook(p);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop).toEqual([entry]);
  });

  it('still adds the recall entry beside a wrapper running a DIFFERENT hook path', () => {
    const command = `sh -c 'my-notify; "${process.execPath}" "/home/u/old/.recall/bin/stop-hook.js"'`;
    const entry = { matcher: '', hooks: [{ type: 'command', command }] };
    const p = setup(JSON.stringify({ hooks: { Stop: [entry], SubagentStop: [entry] } }));
    expect(mergeStopHook(p, HOOK).changed).toBe(true);
    const stop = JSON.parse(readFileSync(p, 'utf8')).hooks.Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual(entry);
    expect(stop[1].hooks[0].command).toBe(CMD);
  });

  it('heals quoted Windows Node/script paths', () => {
    const p = setup(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command',
      command: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\u\.recall\bin\stop-hook.js"` }] }] } }));
    mergeStopHook(p, HOOK);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop).toHaveLength(1);
    expect(removeStopHook(p).changed).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.Stop).toBeUndefined();
  });
});
