/**
 * doctor-statusline — the opt-in statusLine coverage line (spec step 10 / DoD).
 *
 * checkStatuslineHealth is WARN-only and gated on a persisted
 * `statusline.installed`: it reports nothing when the feature is off, and every
 * finding is a warning that never flips the doctor exit code. This locks the
 * four branches (gated-off, clobbered, missing-script, missing-pinned-Node) and
 * the never-empty-exit-code contract against a future refactor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setTestRoot, binDir, statuslineScript, recallRoot } from '../../src/paths.js';
import { checkStatuslineHealth } from '../../src/installer/doctor.js';

let sandbox: string;
let claudeDir: string;
let restore: (() => void) | undefined;
let prevClaude: string | undefined;

/** A command that satisfies isRecallStatusLine (statusline.js under a .recall/ path). */
function recallCmd(): string { return `"${process.execPath}" "${statuslineScript()}"`; }
function writeConfig(statusline: unknown): void {
  writeFileSync(join(recallRoot(), 'config.json'), JSON.stringify({ statusline }, null, 2));
}
function writeSettings(command?: string): void {
  const obj = command ? { statusLine: { type: 'command', command } } : {};
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(obj, null, 2));
}
const RECORD = () => ({ installed: true, command: recallCmd(), priorStatusLine: null, installedAt: 'x' });

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'recall-doctor-sl-'));
  claudeDir = join(sandbox, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  restore = _setTestRoot(join(sandbox, '.recall'));
  mkdirSync(binDir(), { recursive: true });
  prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
});

afterEach(() => {
  restore?.(); restore = undefined;
  if (prevClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prevClaude;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('checkStatuslineHealth', () => {
  it('feature off (no config.statusline) → installed:false, no warnings, even if a recall command is live', () => {
    writeSettings(recallCmd()); // present but the feature was never opted into
    const h = checkStatuslineHealth();
    expect(h.installed).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it('installed + wired + script present + pinned Node present → no warnings', () => {
    writeConfig(RECORD());
    writeSettings(recallCmd());
    writeFileSync(statuslineScript(), '// bundle');
    const h = checkStatuslineHealth();
    expect(h.installed).toBe(true);
    expect(h.warnings).toEqual([]);
  });

  it('installed but settings now points elsewhere (user edited it) → clobber warning', () => {
    writeConfig(RECORD());
    writeSettings('python3 ~/.claude/statusline.py'); // user replaced recall's line
    writeFileSync(statuslineScript(), '// bundle');
    const h = checkStatuslineHealth();
    expect(h.warnings.some((w) => /points elsewhere/.test(w))).toBe(true);
  });

  it('installed but the staged command script is missing → missing-script warning', () => {
    writeConfig(RECORD());
    writeSettings(recallCmd());
    // do NOT create statuslineScript()
    const h = checkStatuslineHealth();
    expect(h.warnings.some((w) => /missing script/.test(w))).toBe(true);
  });

  it('installed but the Node pinned INSIDE the wired command no longer exists → pinned-Node warning', () => {
    writeConfig(RECORD());
    // The wired command pins a Node that has since been removed (brew upgrade
    // etc.). Doctor must read the pin from the COMMAND, not .binding-info.json —
    // every install rewrites the marker to the current node, so it can vouch
    // for a stale pin.
    writeSettings(`"/no/such/node/binary" "${statuslineScript()}"`);
    writeFileSync(statuslineScript(), '// bundle');
    writeFileSync(join(binDir(), '.binding-info.json'), JSON.stringify({ nodePath: process.execPath }));
    const h = checkStatuslineHealth();
    expect(h.warnings.some((w) => /pinned Node path missing/.test(w))).toBe(true);
  });
});
