/**
 * claudemd-nudge — idempotent CLAUDE.md nudge + scoped uninstall removal (§4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyNudge, removeNudge } from '../../src/installer/claudemd-nudge.js';

let dir: string;
function tmpFile(content = ''): string {
  dir = mkdtempSync(join(tmpdir(), 'recall-nudge-'));
  const p = join(dir, 'CLAUDE.md');
  writeFileSync(p, content);
  return p;
}
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

describe('claudemd-nudge', () => {
  it('appends the ## Recall block and ends with a newline', () => {
    const p = tmpFile('');
    const r = applyNudge(p);
    expect(r.changed).toBe(true);
    const out = readFileSync(p, 'utf-8');
    expect(out).toMatch(/^## Recall$/m);
    expect(out).toContain('use the `recall` skill');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is idempotent — second run does not duplicate', () => {
    const p = tmpFile('# Existing\n');
    applyNudge(p);
    const after1 = readFileSync(p, 'utf-8');
    const r2 = applyNudge(p);
    expect(r2.changed).toBe(false);
    const after2 = readFileSync(p, 'utf-8');
    expect(after2).toBe(after1);
    expect(after2.match(/## Recall/g)).toHaveLength(1);
  });

  it('uninstall removes the whole Recall block (incl nested ###), keeps siblings', () => {
    const p = tmpFile([
      '# Title',
      '',
      '## Recall',
      '',
      '- nudge line',
      '',
      '### Sub',
      '',
      'sub content',
      '',
      '## Other Section',
      '',
      'other content',
      '',
    ].join('\n'));

    const r = removeNudge(p);
    expect(r.changed).toBe(true);
    const out = readFileSync(p, 'utf-8');
    expect(out).not.toContain('## Recall');
    expect(out).not.toContain('### Sub');
    expect(out).not.toContain('sub content');
    expect(out).toContain('## Other Section');
    expect(out).toContain('other content');
    expect(out).toContain('# Title');
  });
});
