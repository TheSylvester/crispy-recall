/**
 * statusline-merge — the single-value statusLine contract.
 *
 * Unlike the array hook helpers, `statusLine` is one object. The invariant:
 * recall writes ONLY into an empty-or-already-recall slot and NEVER modifies a
 * foreign value. Ownership is by the self-identifying command
 * (isRecallStatusLine), so uninstall works even without config.json.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot } from '../../src/paths.js';
import {
  isRecallStatusLine, mergeStatusLine, removeStatusLine,
} from '../../src/installer/settings-merge.js';

const SCRIPT = '/home/u/.recall/bin/statusline.js';
const CMD = `"${process.execPath}" "${SCRIPT}"`;
const STALE = `"/old/node" "/prev/.recall/bin/statusline.js"`;
const FOREIGN = 'python3 ~/.claude/statusline.py';

let dir: string;
let restore: (() => void) | undefined;

function setup(content: string, name = 'settings.json'): string {
  dir = mkdtempSync(join(tmpdir(), 'recall-sl-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  restore?.(); restore = undefined;
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('isRecallStatusLine', () => {
  it('recognizes recall commands (statusline.js + .recall/ marker), rejects others', () => {
    expect(isRecallStatusLine(CMD)).toBe(true);
    expect(isRecallStatusLine(STALE)).toBe(true);
    expect(isRecallStatusLine(FOREIGN)).toBe(false);
    expect(isRecallStatusLine('node /somewhere/statusline.js')).toBe(false); // no .recall marker
    expect(isRecallStatusLine(undefined)).toBe(false);
    expect(isRecallStatusLine('')).toBe(false);
  });

  it('NEVER claims a composite command that merely embeds recall\'s script', () => {
    // statusLine is a single slot: claiming a composite would rewrite/delete the
    // user's half on heal/uninstall. The predicate is anchored on the exact
    // two-token shape recall writes.
    expect(isRecallStatusLine(`sh -c 'ccusage statusline; ${CMD}'`)).toBe(false);
    expect(isRecallStatusLine(`${CMD} && ccusage statusline`)).toBe(false);
    expect(isRecallStatusLine(`${CMD} --extra-flag`)).toBe(false);
    // unquoted hand-edit: recall never writes this shape — safe refusal
    expect(isRecallStatusLine(`node /home/u/.recall/bin/statusline.js`)).toBe(false);
    // a dir merely SUFFIXED .recall is somebody else's — full segment required
    expect(isRecallStatusLine(`"/usr/bin/node" "/home/other/backups.recall/statusline.js"`)).toBe(false);
  });

  it('recognizes its own command under a custom RECALL_HOME without a .recall segment', () => {
    const home = mkdtempSync(join(tmpdir(), 'recall-custom-root-')); // no ".recall" in path
    restore = _setTestRoot(home);
    const cmd = `"${process.execPath}" "${join(home, 'bin', 'statusline.js')}"`;
    expect(cmd).not.toMatch(/\.recall/);
    expect(isRecallStatusLine(cmd)).toBe(true); // via live statuslineScript()
    rmSync(home, { recursive: true, force: true });
  });

  it('recognizes the exact command recorded in config.json (last-resort corroboration)', () => {
    const home = mkdtempSync(join(tmpdir(), 'recall-custom-root-'));
    restore = _setTestRoot(home);
    // Recorded under a DIFFERENT prior root (no .recall segment, not the live one).
    const recorded = `"/usr/bin/node" "/mnt/data/recall-home/bin/statusline.js"`;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'),
      JSON.stringify({ statusline: { installed: true, command: recorded, priorStatusLine: null, installedAt: 'x' } }));
    expect(isRecallStatusLine(recorded)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('mergeStatusLine', () => {
  it('writes into an empty slot (no statusLine key) → wroteEmpty', () => {
    const p = setup(JSON.stringify({ hooks: { Stop: [] } }, null, 2));
    const r = mergeStatusLine(p, CMD);
    expect(r.state).toBe('wroteEmpty');
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.statusLine).toEqual({ type: 'command', command: CMD });
    // hooks untouched, indentation preserved
    expect(parsed.hooks.Stop).toEqual([]);
    expect(readFileSync(p, 'utf-8')).toContain('\n  "');
  });

  it('writes into a present-but-blank command slot → wroteEmpty', () => {
    const p = setup(JSON.stringify({ statusLine: { type: 'command', command: '   ' } }, null, 2));
    const r = mergeStatusLine(p, CMD);
    expect(r.state).toBe('wroteEmpty');
    expect(JSON.parse(readFileSync(p, 'utf-8')).statusLine.command).toBe(CMD);
  });

  it('creates the file when absent → wroteEmpty, no backup', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-sl-'));
    const p = join(dir, 'settings.json');
    const r = mergeStatusLine(p, CMD);
    expect(r.state).toBe('wroteEmpty');
    expect((r as { backup?: string }).backup).toBeUndefined();
    expect(JSON.parse(readFileSync(p, 'utf-8')).statusLine.command).toBe(CMD);
  });

  it('REFUSES a foreign value → refusedForeign, file byte-identical', () => {
    const input = JSON.stringify({ statusLine: { type: 'command', command: FOREIGN } }, null, 2);
    const p = setup(input);
    const before = readFileSync(p, 'utf-8');
    const r = mergeStatusLine(p, CMD);
    expect(r.state).toBe('refusedForeign');
    expect(r.changed).toBe(false);
    expect(readFileSync(p, 'utf-8')).toBe(before); // untouched
    // no backup / tmp leftover
    expect(readdirSync(dir).filter((f) => /\.(bak|tmp)\./.test(f))).toEqual([]);
  });

  it('is idempotent — second run on our own command → alreadyRecall, no write', () => {
    const p = setup(JSON.stringify({}, null, 2));
    mergeStatusLine(p, CMD);
    const first = readFileSync(p, 'utf-8');
    const r2 = mergeStatusLine(p, CMD);
    expect(r2.state).toBe('alreadyRecall');
    expect(r2.changed).toBe(false);
    expect(readFileSync(p, 'utf-8')).toBe(first);
  });

  it('heals a stale recall pin in place → alreadyRecall, changed, rewritten', () => {
    const p = setup(JSON.stringify({ statusLine: { type: 'command', command: STALE } }, null, 2));
    const r = mergeStatusLine(p, CMD);
    expect(r.state).toBe('alreadyRecall');
    expect(r.changed).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf-8')).statusLine.command).toBe(CMD);
  });

  it('preserves user-added sibling keys (padding etc.) when healing an owned slot', () => {
    const p = setup(JSON.stringify({ statusLine: { type: 'command', command: STALE, padding: 0 } }, null, 2));
    const r = mergeStatusLine(p, CMD);
    expect(r.changed).toBe(true);
    const sl = JSON.parse(readFileSync(p, 'utf-8')).statusLine;
    expect(sl.command).toBe(CMD);
    expect(sl.padding).toBe(0); // survived the heal
  });

  it('REFUSES present-but-unreadable shapes instead of misreading them as empty', () => {
    // Each is PRESENT user content in a shape recall can't read — a plausible
    // hand-edit (string command, array command, …). Overwriting would clobber
    // expressed intent; all must be refused byte-identical.
    const shapes: unknown[] = [
      '~/bin/my-statusline.sh',                              // statusLine as a string
      ['bash', 'sl.sh'],                                     // statusLine as an array
      { type: 'command', command: ['bash', 'sl.sh'] },       // command as an array
      { type: 'command', command: 42 },                      // command as a number
    ];
    for (const statusLine of shapes) {
      const input = JSON.stringify({ statusLine }, null, 2);
      const p = setup(input);
      const before = readFileSync(p, 'utf-8');
      const r = mergeStatusLine(p, CMD);
      expect(r.state, JSON.stringify(statusLine)).toBe('refusedForeign');
      expect(r.changed).toBe(false);
      expect(readFileSync(p, 'utf-8')).toBe(before);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats content-free shapes as empty (null statusLine, object without command)', () => {
    for (const statusLine of [null, { type: 'command' }, { type: 'command', command: null }]) {
      const p = setup(JSON.stringify({ statusLine }, null, 2));
      const r = mergeStatusLine(p, CMD);
      expect(r.state, JSON.stringify(statusLine)).toBe('wroteEmpty');
      expect(JSON.parse(readFileSync(p, 'utf-8')).statusLine.command).toBe(CMD);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES (does not heal) a composite command embedding recall\'s script', () => {
    const composite = `sh -c 'ccusage statusline; ${CMD.replace(/"/g, '\\"')}'`;
    const input = JSON.stringify({ statusLine: { type: 'command', command: composite } }, null, 2);
    const p = setup(input);
    const before = readFileSync(p, 'utf-8');
    const r = mergeStatusLine(p, CMD);
    expect(r.state).toBe('refusedForeign');
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('preserves CRLF and writes atomically (no leftover tmp)', () => {
    const input = JSON.stringify({ hooks: {} }, null, 2).replace(/\n/g, '\r\n');
    const p = setup(input);
    mergeStatusLine(p, CMD);
    const out = readFileSync(p, 'utf-8');
    expect(out.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect(readdirSync(dir).filter((f) => /\.tmp\./.test(f))).toEqual([]);
  });
});

describe('removeStatusLine', () => {
  it('owned + no config → deletes the statusLine key', () => {
    const p = setup(JSON.stringify({ statusLine: { type: 'command', command: CMD }, hooks: {} }, null, 2));
    // point recall root at an empty dir (no config.json) — cleanup must still work
    const home = mkdtempSync(join(tmpdir(), 'recall-home-'));
    restore = _setTestRoot(home);
    const r = removeStatusLine(p);
    rmSync(home, { recursive: true, force: true });
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.statusLine).toBeUndefined();
    expect(parsed.hooks).toEqual({}); // rest untouched
  });

  it('owned + stashed prior → restores the prior statusLine', () => {
    const p = setup(JSON.stringify({ statusLine: { type: 'command', command: CMD } }, null, 2));
    const home = mkdtempSync(join(tmpdir(), 'recall-home-'));
    restore = _setTestRoot(home);
    const prior = { type: 'command', command: FOREIGN };
    writeFileSync(join(home, 'config.json'),
      JSON.stringify({ statusline: { installed: true, command: CMD, priorStatusLine: prior, installedAt: 'x' } }, null, 2));
    const r = removeStatusLine(p);
    rmSync(home, { recursive: true, force: true });
    expect(r.changed).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf-8')).statusLine).toEqual(prior);
  });

  it('foreign value → no-op', () => {
    const input = JSON.stringify({ statusLine: { type: 'command', command: FOREIGN } }, null, 2);
    const p = setup(input);
    const before = readFileSync(p, 'utf-8');
    const r = removeStatusLine(p);
    expect(r.changed).toBe(false);
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('composite command embedding recall\'s script → no-op (never deletes the user\'s half)', () => {
    const composite = `sh -c 'ccusage statusline; ${CMD.replace(/"/g, '\\"')}'`;
    const input = JSON.stringify({ statusLine: { type: 'command', command: composite } }, null, 2);
    const p = setup(input);
    const before = readFileSync(p, 'utf-8');
    const r = removeStatusLine(p);
    expect(r.changed).toBe(false);
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('unreadable statusLine shape → no-op', () => {
    const input = JSON.stringify({ statusLine: '~/bin/my-statusline.sh' }, null, 2);
    const p = setup(input);
    const before = readFileSync(p, 'utf-8');
    const r = removeStatusLine(p);
    expect(r.changed).toBe(false);
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('absent file → no-op', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-sl-'));
    const r = removeStatusLine(join(dir, 'nope.json'));
    expect(r.changed).toBe(false);
  });

  it('lost config but owned command → still cleans up via isRecallStatusLine', () => {
    const p = setup(JSON.stringify({ statusLine: { type: 'command', command: STALE } }, null, 2));
    // STALE is a recall command at a different path; ownership is path-independent.
    const home = mkdtempSync(join(tmpdir(), 'recall-home-'));
    restore = _setTestRoot(home);
    mkdirSync(home, { recursive: true }); // exists but no config.json
    const r = removeStatusLine(p);
    rmSync(home, { recursive: true, force: true });
    expect(r.changed).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf-8')).statusLine).toBeUndefined();
  });
});
