/**
 * statusline-segment — pure renderers for the Claude Code status line.
 *
 * The leaf module must never throw and must degrade gracefully on missing
 * fields (only session_id is guaranteed present in Claude's stdin JSON).
 */
import { describe, expect, it } from 'vitest';
import { renderStatuslineSegment, renderStandaloneStatusline } from '../../src/recall/statusline-segment.js';

describe('renderStatuslineSegment', () => {
  it('renders the session-id chip when present', () => {
    expect(renderStatuslineSegment({ session_id: 'abc-123' })).toBe('🔗 abc-123');
  });

  it('is empty when session_id is absent / blank / non-string', () => {
    expect(renderStatuslineSegment({})).toBe('');
    expect(renderStatuslineSegment({ session_id: '' })).toBe('');
    // defensive: non-string never throws
    expect(renderStatuslineSegment({ session_id: undefined })).toBe('');
    expect(renderStatuslineSegment({ session_id: 123 as unknown as string })).toBe('');
  });
});

describe('renderStandaloneStatusline', () => {
  it('assembles basename(cwd) · model · chip', () => {
    expect(
      renderStandaloneStatusline({
        session_id: 'sid-9',
        cwd: '/home/silver/dev/recall',
        model: { display_name: 'Claude Opus 4.8' },
      }),
    ).toBe('recall · Claude Opus 4.8 · 🔗 sid-9');
  });

  it('drops the cwd part when cwd is missing', () => {
    expect(renderStandaloneStatusline({ session_id: 's', model: { display_name: 'Sonnet' } }))
      .toBe('Sonnet · 🔗 s');
  });

  it('drops the model part when model/display_name is missing', () => {
    expect(renderStandaloneStatusline({ session_id: 's', cwd: '/a/b/proj' }))
      .toBe('proj · 🔗 s');
  });

  it('degrades to just the chip when only session_id is present', () => {
    expect(renderStandaloneStatusline({ session_id: 'only' })).toBe('🔗 only');
  });

  it('never throws on an empty object and yields empty string', () => {
    expect(renderStandaloneStatusline({})).toBe('');
  });
});
