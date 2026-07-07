/**
 * statusline-suggest — detection + the "both options" message.
 *
 * detectStatusline classifies the user's current statusLine; renderStatuslineSuggestion
 * produces the never-clobber message with BOTH a paste-snippet (Option A) and a
 * `claude -p` prompt (Option B).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectStatusline, renderStatuslineSuggestion } from '../../src/installer/statusline-suggest.js';

let dir: string;
function settingsWith(statusLine: unknown): string {
  dir = mkdtempSync(join(tmpdir(), 'recall-detect-'));
  const p = join(dir, 'settings.json');
  writeFileSync(p, JSON.stringify(statusLine === undefined ? {} : { statusLine }, null, 2));
  return p;
}
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

const cmd = (command: string) => ({ type: 'command', command });

describe('detectStatusline', () => {
  it('none — no statusLine key', () => {
    const d = detectStatusline(settingsWith(undefined));
    expect(d).toMatchObject({ present: false, kind: 'none' });
  });

  it('none — absent file', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-detect-'));
    expect(detectStatusline(join(dir, 'missing.json')).kind).toBe('none');
  });

  it('none — present but blank command', () => {
    expect(detectStatusline(settingsWith(cmd('  '))).kind).toBe('none');
  });

  it('recall — our own pinned command', () => {
    const our = `"${process.execPath}" "/home/u/.recall/bin/statusline.js"`;
    const d = detectStatusline(settingsWith(cmd(our)));
    expect(d.kind).toBe('recall');
  });

  it('python — extracts the .py scriptPath', () => {
    const d = detectStatusline(settingsWith(cmd('python3 ~/.claude/statusline.py')));
    expect(d.kind).toBe('python');
    expect(d.scriptPath).toBe('~/.claude/statusline.py');
  });

  it('node — extracts the .js scriptPath (and is not misread as recall)', () => {
    const d = detectStatusline(settingsWith(cmd('node /home/me/.config/statusline.js')));
    expect(d.kind).toBe('node');
    expect(d.scriptPath).toBe('/home/me/.config/statusline.js');
  });

  it('shell — extracts the .sh scriptPath', () => {
    const d = detectStatusline(settingsWith(cmd('bash ~/bin/status.sh')));
    expect(d.kind).toBe('shell');
    expect(d.scriptPath).toBe('~/bin/status.sh');
  });

  it('thirdparty — npx/ccusage classified before extension heuristics', () => {
    expect(detectStatusline(settingsWith(cmd('npx ccusage statusline'))).kind).toBe('thirdparty');
    expect(detectStatusline(settingsWith(cmd('bunx ccstatusline'))).kind).toBe('thirdparty');
  });

  it('unknown — a bare binary with no recognizable interpreter/extension', () => {
    expect(detectStatusline(settingsWith(cmd('/usr/local/bin/mystatus'))).kind).toBe('unknown');
  });

  it('honors quoted paths containing spaces', () => {
    const d = detectStatusline(settingsWith(cmd('python3 "/Users/me/My Scripts/statusline.py"')));
    expect(d.kind).toBe('python');
    expect(d.scriptPath).toBe('/Users/me/My Scripts/statusline.py');
  });

  it('present-but-unreadable shapes are FOREIGN (unknown), never none — mirrors mergeStatusLine', () => {
    // A misread here would let the installer treat real user content as an
    // empty slot; detect and merge share classifyStatusLineSlot so they agree.
    expect(detectStatusline(settingsWith('~/bin/my-statusline.sh'))).toMatchObject({ present: true, kind: 'unknown' });
    expect(detectStatusline(settingsWith(['bash', 'sl.sh']))).toMatchObject({ present: true, kind: 'unknown' });
    expect(detectStatusline(settingsWith(cmd(42 as unknown as string)))).toMatchObject({ present: true, kind: 'unknown' });
  });

  it('content-free shapes are none (null statusLine, object without command)', () => {
    expect(detectStatusline(settingsWith(null)).kind).toBe('none');
    expect(detectStatusline(settingsWith({ type: 'command' })).kind).toBe('none');
  });

  it('an UNPARSEABLE settings.json is present/unknown, never none', () => {
    // It may well contain a statusline — "you have none, run install" would be
    // wrong and the recommended install would fail on the same file.
    dir = mkdtempSync(join(tmpdir(), 'recall-detect-'));
    const p = join(dir, 'settings.json');
    writeFileSync(p, '{ definitely not json ]]');
    expect(detectStatusline(p)).toMatchObject({ present: true, kind: 'unknown' });
  });

  it('composite command embedding recall\'s script is NOT recall', () => {
    const our = `"${process.execPath}" "/home/u/.recall/bin/statusline.js"`;
    const d = detectStatusline(settingsWith(cmd(`sh -c 'ccusage statusline; ${our.replace(/"/g, '\\"')}'`)));
    expect(d.kind).not.toBe('recall');
    expect(d.present).toBe(true);
  });
});

describe('renderStatuslineSuggestion', () => {
  it('foreign (python): contains the never-touch note AND both options', () => {
    const d = detectStatusline(settingsWith(cmd('python3 ~/.claude/statusline.py')));
    const msg = renderStatuslineSuggestion(d);
    expect(msg).toContain("recall won't change your statusline");
    expect(msg).toContain('python3 ~/.claude/statusline.py'); // echoes their command
    // Option A — python snippet
    expect(msg).toContain('── Option A');
    expect(msg).toContain('data.get("session_id")');
    // Option B — claude -p prompt referencing the script path
    expect(msg).toContain('── Option B');
    expect(msg).toContain('claude -p');
    expect(msg).toContain('statusline.py');
    // Tip about the subcommand + re-run
    expect(msg).toContain('recall statusline --suggest');
  });

  it('node foreign: Option A shows the JS snippet', () => {
    const d = detectStatusline(settingsWith(cmd('node ~/.config/statusline.js')));
    const msg = renderStatuslineSuggestion(d);
    expect(msg).toContain('parts.push(`🔗 ${sid}`)');
    expect(msg).toContain('── Option B');
  });

  it('thirdparty: Option A is the external-command note, Option B has no scriptPath', () => {
    const d = detectStatusline(settingsWith(cmd('npx ccusage statusline')));
    const msg = renderStatuslineSuggestion(d);
    expect(msg).toContain('external command');
    expect(msg).toContain('── Option B');
    expect(msg).toContain('My Claude Code statusLine command is:'); // command-based prompt
  });

  it('none: points the user at `recall install --statusline`', () => {
    const msg = renderStatuslineSuggestion(detectStatusline(settingsWith(undefined)));
    expect(msg).toContain('recall install --statusline');
  });

  it('recall: reports it already manages the statusline', () => {
    const our = `"${process.execPath}" "/home/u/.recall/bin/statusline.js"`;
    const msg = renderStatuslineSuggestion(detectStatusline(settingsWith(cmd(our))));
    expect(msg).toContain('already manages');
  });
});
