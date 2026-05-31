/**
 * transcriptGlob — forward-slash glob pattern construction.
 *
 * Regression (Windows-only): transcript discovery built its glob with
 * `path.join`, which emits `\` on Windows. The `glob` library treats `\` as an
 * escape character, so `C:\Users\me\.claude\projects\**\*.jsonl` matched NOTHING
 * — backfill and mtime-scan found 0 transcripts on Windows-native while the
 * install otherwise looked healthy. transcriptGlob must always yield a
 * forward-slash pattern (including for roots that already carry backslashes).
 */
import { describe, expect, it } from 'vitest';
import { globSync } from 'glob';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transcriptGlob } from '../../src/paths.js';

describe('transcriptGlob', () => {
  it('joins segments with forward slashes', () => {
    expect(transcriptGlob('/home/me/.claude', 'projects', '**', '*.jsonl'))
      .toBe('/home/me/.claude/projects/**/*.jsonl');
  });

  it('normalizes backslashes in a Windows-style root', () => {
    // The kind of root homedir() returns on Windows-native.
    const out = transcriptGlob('C:\\Users\\me\\.claude', 'projects', '**', '*.jsonl');
    expect(out).toBe('C:/Users/me/.claude/projects/**/*.jsonl');
    expect(out).not.toContain('\\');
  });

  it('produces a pattern glob actually matches on disk', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'recall-glob-'));
    try {
      const projDir = join(sandbox, 'projects', '-encoded-project');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'a1b2c3d4-0000-0000-0000-000000000000.jsonl');
      writeFileSync(file, '{}\n');

      const matches = globSync(transcriptGlob(sandbox, 'projects', '**', '*.jsonl'), { nodir: true });
      expect(matches.length).toBe(1);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
