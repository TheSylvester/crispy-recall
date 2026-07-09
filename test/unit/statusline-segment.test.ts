/**
 * statusline-segment — pure renderers for the Claude Code status line.
 *
 * The leaf module must never throw and must degrade gracefully on missing
 * fields (only session_id is guaranteed present in Claude's stdin JSON). The
 * wired standalone line is muted + dot-separated; the bare chip is plain (it is
 * pasted into foreign, self-colored status lines).
 */
import { describe, expect, it } from 'vitest';
import {
  renderStatuslineSegment,
  renderStandaloneStatusline,
  type StatuslineInput,
} from '../../src/recall/statusline-segment.js';

/** Drop ANSI SGR codes so assertions read the plain structure. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const CTX = (pct: number): StatuslineInput['context_window'] => ({
  context_window_size: 100_000,
  current_usage: { input_tokens: pct * 1000 },
});

describe('renderStatuslineSegment (bare chip — stays plain)', () => {
  it('renders the session-id chip when present, with NO color codes', () => {
    const out = renderStatuslineSegment({ session_id: 'abc-123' });
    expect(out).toBe('🔗 abc-123');
    expect(out).not.toMatch(/\x1b\[/); // pasted into foreign lines — must be plain
  });

  it('is empty when session_id is absent / blank / non-string', () => {
    expect(renderStatuslineSegment({})).toBe('');
    expect(renderStatuslineSegment({ session_id: '' })).toBe('');
    expect(renderStatuslineSegment({ session_id: undefined })).toBe('');
    expect(renderStatuslineSegment({ session_id: 123 as unknown as string })).toBe('');
  });
});

describe('renderStandaloneStatusline (wired muted line)', () => {
  it('assembles dir(+git) · model · context · chip', () => {
    const out = renderStandaloneStatusline(
      {
        session_id: 'sid-9',
        workspace: { current_dir: '/home/silver/dev/recall' },
        model: { display_name: 'Claude Opus 4.8' },
        context_window: CTX(34),
      },
      { git: { branch: 'main', dirty: true } },
    );
    expect(strip(out)).toBe('recall (main*) · Opus 🧠 4.8 · 💿 34% · 🔗 sid-9');
  });

  it('reads workspace.current_dir, else top-level cwd', () => {
    expect(strip(renderStandaloneStatusline({ cwd: '/a/b/proj' }))).toBe('proj');
  });

  it('shows a clean branch with no star', () => {
    const out = renderStandaloneStatusline(
      { workspace: { current_dir: '/x/recall' } },
      { git: { branch: 'feat/x', dirty: false } },
    );
    expect(strip(out)).toBe('recall (feat/x)');
  });

  it('drops the git suffix when no git info is supplied', () => {
    expect(strip(renderStandaloneStatusline({ cwd: '/x/recall' }))).toBe('recall');
  });

  it('picks the model family icon and splits name/version', () => {
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'Claude Opus 4.8' } }))).toBe(
      'Opus 🧠 4.8',
    );
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'Claude Sonnet 5' } }))).toBe(
      'Sonnet ⚡ 5',
    );
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'Claude Haiku 4.5' } }))).toBe(
      'Haiku 💲 4.5',
    );
  });

  it('renders a model with no version number', () => {
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'Sonnet' } }))).toBe(
      'Sonnet ⚡',
    );
  });

  it('resolves family + version regardless of order, and drops parentheticals', () => {
    // parenthetical suffix (this environment's own display name)
    expect(
      strip(renderStandaloneStatusline({ model: { display_name: 'Claude Opus 4.8 (1M context)' } })),
    ).toBe('Opus 🧠 4.8');
    // version-FIRST legacy naming → still <family> <icon> <version>
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'Claude 3.5 Haiku' } }))).toBe(
      'Haiku 💲 3.5',
    );
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'Claude 3.5 Sonnet' } }))).toBe(
      'Sonnet ⚡ 3.5',
    );
    // non-Claude name (no family keyword) stays intact rather than "GPT- ⚡ 5"
    expect(strip(renderStandaloneStatusline({ model: { display_name: 'GPT-5' } }))).toBe('GPT-5 ⚡');
  });

  it('computes the context percentage (floored) and shows the disk glyph', () => {
    expect(strip(renderStandaloneStatusline({ context_window: CTX(34) }))).toBe('💿 34%');
    // (7*1000)*100 / 100000 = 7% (floored)
    expect(strip(renderStandaloneStatusline({ context_window: CTX(7) }))).toBe('💿 7%');
  });

  it('drops the context segment when there is no real reading (never a misleading 0%)', () => {
    const chip = (i: StatuslineInput) => strip(renderStandaloneStatusline({ session_id: 's', ...i }));
    expect(chip({})).toBe('🔗 s'); // no context_window at all (older Claude Code)
    expect(chip({ context_window: { current_usage: null } })).toBe('🔗 s');
    expect(chip({ context_window: { context_window_size: 100_000, current_usage: {} } })).toBe('🔗 s'); // present but empty reading
    expect(chip({ context_window: { current_usage: { input_tokens: 5000 } } })).toBe('🔗 s'); // no usable window size
    // hostile / non-numeric token field → ignored, never "💿 NaN%"
    expect(
      chip({ context_window: { context_window_size: 100_000, current_usage: { input_tokens: 'abc' as unknown as number } } }),
    ).toBe('🔗 s');
  });

  it('escalates the context meter color across the threshold bands', () => {
    const at = (pct: number) => renderStandaloneStatusline({ context_window: CTX(pct) });
    expect(at(5)).toContain('\x1b[2;37m5%'); // <11 dim
    expect(at(10)).toContain('\x1b[2;37m10%'); // boundary stays dim
    expect(at(11)).toContain('\x1b[37m11%'); // 11–20 grey
    expect(at(21)).toContain('\x1b[32m21%'); // 21–40 green
    expect(at(41)).toContain('\x1b[33m41%'); // 41–60 yellow
    expect(at(61)).toContain('\x1b[31m61%'); // 61–80 red
    expect(at(80)).toContain('\x1b[31m80%'); // boundary stays red
    expect(at(81)).toContain('\x1b[1;31m81%'); // 81+ bold red (critical)
  });

  it('sums input + cache-creation + cache-read tokens for usage', () => {
    const out = renderStandaloneStatusline({
      context_window: {
        context_window_size: 100_000,
        current_usage: {
          input_tokens: 10_000,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 25_000,
        },
      },
    });
    expect(strip(out)).toBe('💿 40%'); // 40000 / 100000
  });

  it('colors the session id dim grey (not bright magenta), and keeps the model unbolded', () => {
    const out = renderStandaloneStatusline({
      session_id: 'sid',
      model: { display_name: 'Claude Opus 4.8' },
    });
    expect(out).toContain('\x1b[2;37msid\x1b[0m'); // dim-grey session id
    expect(out).not.toContain('\x1b[95m'); // no magenta anywhere
    expect(out).not.toContain('\x1b[1;97m'); // model name is not bold-white
  });

  it('degrades to just the chip when only session_id is present', () => {
    expect(strip(renderStandaloneStatusline({ session_id: 'only' }))).toBe('🔗 only');
  });

  it('never throws on an empty object and yields empty string', () => {
    expect(renderStandaloneStatusline({})).toBe('');
    expect(renderStandaloneStatusline({}, {})).toBe('');
  });
});
