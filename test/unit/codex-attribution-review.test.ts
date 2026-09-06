import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/adapters/claude/transcript-edits.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/adapters/claude/transcript-edits.js')>();
  return { ...actual, extractSessionEdits: vi.fn(actual.extractSessionEdits) };
});
import { extractSessionEdits } from '../../src/adapters/claude/transcript-edits.js';
import { findSessionsForBlame, findSessionsForCommit } from '../../src/git-attribution.js';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recall-codex-review-'));
  const repo = join(root, 'repo');
  const sessions = join(root, 'codex', '2026', '09', '06');
  mkdirSync(repo); mkdirSync(sessions, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test'); git('config', 'commit.gpgsign', 'false');
  const commit = (minutes: number) => {
    git('add', '-A');
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: ago(minutes), GIT_COMMITTER_DATE: ago(minutes) } });
    return git('rev-parse', 'HEAD');
  };
  const rollout = join(sessions, 'rollout.jsonl');
  const writeRollout = (id: string, patches: string[]) => writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', timestamp: ago(9), payload: { id, cwd: repo } }),
    ...patches.map((input, i) => JSON.stringify({ type: 'response_item', timestamp: ago(7 - i * 4), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: `patch-${i}`, input } })),
  ].join('\n') + '\n');
  return { root, repo, rollout, commit, writeRollout, opts: { repoRoot: repo, sessionsDir: join(root, 'no-claude'), codexSessionsDir: join(root, 'codex') } };
}

describe('Codex attribution review regressions', () => {
  it('attributes a rename plus edit to the Move to destination in a real git commit', async () => {
    const f = fixture();
    try {
      const unchanged = Array.from({ length: 20 }, (_, i) => `const unchanged${i} = ${i};`).join('\n');
      writeFileSync(join(f.repo, 'old.ts'), unchanged + '\nold1\nold2\nold3\n'); f.commit(10);
      renameSync(join(f.repo, 'old.ts'), join(f.repo, 'new.ts'));
      writeFileSync(join(f.repo, 'new.ts'), unchanged + '\nnew1\nnew2\nnew3\n'); const hash = f.commit(6);
      f.writeRollout('rename-session', ['*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old1\n-old2\n-old3\n+new1\n+new2\n+new3\n*** End Patch']);
      const matches = await findSessionsForCommit(hash, f.opts);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ session: 'rename-session', matched_files: ['new.ts'], surviving_ratio: 1 });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('parses a rollout once across blame commits, then reloads it in the next invocation', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, 'file.ts'), 'base\n'); f.commit(10);
      writeFileSync(join(f.repo, 'file.ts'), 'base\nfirst1\nfirst2\nfirst3\n'); f.commit(6);
      writeFileSync(join(f.repo, 'file.ts'), 'base\nfirst1\nfirst2\nfirst3\nsecond1\nsecond2\nsecond3\n'); f.commit(2);
      const patches = ['first', 'second'].map(prefix => `*** Begin Patch\n*** Update File: file.ts\n@@\n+${prefix}1\n+${prefix}2\n+${prefix}3\n*** End Patch`);
      f.writeRollout('initial-session', patches);
      vi.mocked(extractSessionEdits).mockClear();
      const matches = await findSessionsForBlame([{ path: 'file.ts' }], f.opts);
      expect(matches).toHaveLength(2);
      expect(extractSessionEdits).toHaveBeenCalledTimes(1);
      f.writeRollout('updated-session', patches);
      const refreshed = await findSessionsForBlame([{ path: 'file.ts' }], f.opts);
      expect(refreshed).toHaveLength(2);
      expect(refreshed.every(m => m.session === 'updated-session')).toBe(true);
      expect(extractSessionEdits).toHaveBeenCalledTimes(2);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
