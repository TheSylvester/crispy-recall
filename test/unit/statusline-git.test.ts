/**
 * parseGitStatus — pure parse of `git status --porcelain=v1 --branch` stdout
 * into { branch, dirty }. Feeds the wired statusline's `(branch*)` segment. The
 * spawn wrapper around it (readGit) is time-boxed + fully guarded in the entry;
 * this covers the parse, which is where all the branch-shape edge cases live.
 */
import { describe, expect, it } from 'vitest';
import { parseGitStatus } from '../../src/hooks/statusline.js';

describe('parseGitStatus', () => {
  it('reads a clean branch with an upstream', () => {
    expect(parseGitStatus('## main...origin/main\n')).toEqual({ branch: 'main', dirty: false });
  });

  it('flags dirty when there are porcelain entries', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n M src/x.ts\n?? y.ts\n')).toEqual({
      branch: 'main',
      dirty: true,
    });
  });

  it('reads a branch with no upstream', () => {
    expect(parseGitStatus('## feat/statusline\n')).toEqual({ branch: 'feat/statusline', dirty: false });
  });

  it('reads a fresh repo (no commits yet)', () => {
    expect(parseGitStatus('## No commits yet on main\n?? README.md\n')).toEqual({
      branch: 'main',
      dirty: true,
    });
  });

  it('reads a fresh repo on git < 2.16 ("Initial commit on" wording)', () => {
    expect(parseGitStatus('## Initial commit on master\n')).toEqual({ branch: 'master', dirty: false });
    expect(parseGitStatus('## Initial commit on master\n?? a.txt\n')).toEqual({ branch: 'master', dirty: true });
  });

  it('keeps branch names with slashes and dots intact', () => {
    expect(parseGitStatus('## feat/v1.2...origin/feat/v1.2 [ahead 2]\n')).toEqual({
      branch: 'feat/v1.2',
      dirty: false,
    });
  });

  it('returns undefined on a detached HEAD (no branch to show)', () => {
    expect(parseGitStatus('## HEAD (no branch)\n')).toBeUndefined();
  });

  it('returns undefined when there is no branch header (non-repo / empty)', () => {
    expect(parseGitStatus('')).toBeUndefined();
    expect(parseGitStatus('not git output')).toBeUndefined();
    expect(parseGitStatus(undefined as unknown as string)).toBeUndefined();
  });
});
