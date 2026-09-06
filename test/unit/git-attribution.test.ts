import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import { findSessionsForCommit, findSessionsForBlame, getCommitInfo, parseBlameSpec } from '../../src/git-attribution.js';
import { extractSessionEdits } from '../../src/adapters/claude/transcript-edits.js';

// ----------------------------------------------------------------------------
// Tiny in-memory fixture builders. We synthesize a throwaway git repo + a
// Claude-style sessions directory in os.tmpdir(), then drive the matcher
// against them. Keeps tests hermetic, fast, and independent of the real
// ~/.claude/projects/ contents.
// ----------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * ISO timestamp `minutes` before now. The fixtures date their commits relative
 * to the wall clock (not a hardcoded calendar date) so the matcher's mtime
 * prefilter — [parentTime-60s, commitTime+24h] — always contains the session
 * jsonl files, which are written at test time. A hardcoded past date silently
 * falls outside that 24h window once the machine clock advances past it,
 * starving every candidate (a latent time-bomb in the original fixture).
 */
function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function initRepo(repo: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
}

function commit(
  repo: string,
  message: string,
  writes: Array<{ file: string; content: string }>,
  dateIso?: string,
): string {
  for (const w of writes) {
    const full = path.join(repo, w.file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, w.content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const env = dateIso
    ? { ...process.env, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
    : process.env;
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

/**
 * Build a synthetic assistant tool_use jsonl event for a given file edit.
 * Mirrors the exact shape extractSessionEdits looks for.
 */
function editEvent(opts: { tool: 'Edit' | 'Write' | 'MultiEdit'; filePath: string; newString: string; ts: string }): string {
  let block: unknown;
  if (opts.tool === 'Edit') {
    block = { type: 'tool_use', name: 'Edit', input: { file_path: opts.filePath, new_string: opts.newString } };
  } else if (opts.tool === 'Write') {
    block = { type: 'tool_use', name: 'Write', input: { file_path: opts.filePath, content: opts.newString } };
  } else {
    block = {
      type: 'tool_use',
      name: 'MultiEdit',
      input: { file_path: opts.filePath, edits: [{ old_string: 'X', new_string: opts.newString }] },
    };
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    message: { role: 'assistant', content: [block] },
  });
}

function writeSessionJsonl(sessionsDir: string, sessionId: string, events: string[]): string {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, events.join('\n') + '\n', 'utf8');
  return file;
}

function writeSubagentJsonl(
  sessionsDir: string,
  parentSessionId: string,
  agentId: string,
  events: string[],
  agentType?: string,
): string {
  const subDir = path.join(sessionsDir, parentSessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const file = path.join(subDir, `${agentId}.jsonl`);
  fs.writeFileSync(file, events.join('\n') + '\n', 'utf8');
  if (agentType !== undefined) {
    fs.writeFileSync(path.join(subDir, `${agentId}.meta.json`), JSON.stringify({ agentType }), 'utf8');
  }
  return file;
}

// A multi-line file body, distinctive enough to generate stable tri-grams.
const PAYLOAD_V1 = [
  'export function greet(name: string): string {',
  '  const greeting = `hello, ${name}`;',
  '  console.log(greeting);',
  '  return greeting;',
  '}',
].join('\n') + '\n';

const PAYLOAD_V2 = [
  'export function greet(name: string): string {',
  '  const greeting = `hi there, ${name}`;',
  '  const decorated = `>> ${greeting} <<`;',
  '  console.log(decorated);',
  '  return decorated;',
  '}',
].join('\n') + '\n';

// ----------------------------------------------------------------------------
// Test fixture wiring
// ----------------------------------------------------------------------------

interface Fixture {
  repo: string;
  sessionsDir: string;
  commit1: string;
  commit2: string;
  commit1AuthorIso: string;
  commit2AuthorIso: string;
}

let fx: Fixture;

beforeAll(() => {
  const repo = tmpDir('git-attr-repo-');
  initRepo(repo);

  // Use explicit commit times spaced 10 minutes apart so the matcher's
  // [parent_time, commit_time + 1h] window has real breathing room.
  // Without this, back-to-back `git commit` calls share a second-precision
  // timestamp and the window collapses to zero.
  const baselineIso = isoMinutesAgo(30);
  const commit1Iso = isoMinutesAgo(20);
  const commit2Iso = isoMinutesAgo(10);

  // Baseline commit (nothing the matcher should attribute against).
  commit(repo, 'init', [{ file: 'README.md', content: '# test\n' }], baselineIso);

  // Commit 1: introduces src/greet.ts at PAYLOAD_V1
  const commit1 = commit(repo, 'feat: add greet', [{ file: 'src/greet.ts', content: PAYLOAD_V1 }], commit1Iso);
  // Commit 2: rewrites greet.ts to PAYLOAD_V2
  const commit2 = commit(repo, 'refactor: rewrite greet', [{ file: 'src/greet.ts', content: PAYLOAD_V2 }], commit2Iso);

  const sessionsDir = tmpDir('git-attr-sessions-');

  // Time anchors for synthetic edits.
  const commit1AuthorIso = execFileSync('git', ['show', '-s', '--pretty=%aI', commit1], { cwd: repo, encoding: 'utf8' }).trim();
  const commit2AuthorIso = execFileSync('git', ['show', '-s', '--pretty=%aI', commit2], { cwd: repo, encoding: 'utf8' }).trim();
  const c1Ms = Date.parse(commit1AuthorIso);
  const c2Ms = Date.parse(commit2AuthorIso);

  // Session A — typed PAYLOAD_V1 just before commit1. Should attribute to commit1.
  const sessAEdits = [
    editEvent({
      tool: 'Edit',
      filePath: path.join(repo, 'src/greet.ts'),
      newString: PAYLOAD_V1,
      ts: new Date(c1Ms - 5_000).toISOString(),
    }),
  ];
  writeSessionJsonl(sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sessAEdits);

  // Session B — typed PAYLOAD_V2 just before commit2. Should attribute to commit2.
  const sessBEdits = [
    editEvent({
      tool: 'Write',
      filePath: path.join(repo, 'src/greet.ts'),
      newString: PAYLOAD_V2,
      ts: new Date(c2Ms - 5_000).toISOString(),
    }),
  ];
  writeSessionJsonl(sessionsDir, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', sessBEdits);

  // Session C — touched a completely different file. Should match neither.
  const sessCEdits = [
    editEvent({
      tool: 'Edit',
      filePath: path.join(repo, 'src/other.ts'),
      newString: 'export const unrelated = 42;\nconst x = 1;\nconst y = 2;\n',
      ts: new Date(c1Ms - 1_000).toISOString(),
    }),
  ];
  writeSessionJsonl(sessionsDir, 'cccccccc-cccc-cccc-cccc-cccccccccccc', sessCEdits);

  // Subagent under parent D — also typed PAYLOAD_V2 right before commit2.
  // Should attribute to commit2, with parent_session_id populated.
  const subAgentEdits = [
    editEvent({
      tool: 'MultiEdit',
      filePath: path.join(repo, 'src/greet.ts'),
      newString: PAYLOAD_V2,
      ts: new Date(c2Ms - 2_000).toISOString(),
    }),
  ];
  writeSubagentJsonl(
    sessionsDir,
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'agent-deadbeefdeadbeef',
    subAgentEdits,
    'Explore',
  );

  fx = { repo, sessionsDir, commit1, commit2, commit1AuthorIso, commit2AuthorIso };
});

afterAll(() => {
  if (fx?.repo) fs.rmSync(fx.repo, { recursive: true, force: true });
  if (fx?.sessionsDir) fs.rmSync(fx.sessionsDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('extractSessionEdits', () => {
  it('extracts Edit/Write/MultiEdit tool calls with normalized paths', async () => {
    const file = path.join(fx.sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    const trace = await extractSessionEdits(file, { repoRoot: fx.repo });
    expect(trace.sessionId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(trace.edits.length).toBe(1);
    expect(trace.edits[0]!.file).toBe('src/greet.ts');
    expect(trace.edits[0]!.content).toContain('export function greet');
    expect(trace.skippedLines).toBe(0);
    expect(trace.skippedEvents).toBe(0);
  });

  it('extracts agent-<hash> as sessionId for subagent files', async () => {
    const file = path.join(
      fx.sessionsDir,
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'subagents',
      'agent-deadbeefdeadbeef.jsonl',
    );
    const trace = await extractSessionEdits(file, { repoRoot: fx.repo });
    expect(trace.sessionId).toBe('agent-deadbeefdeadbeef');
    expect(trace.edits.length).toBe(1);
  });
});

describe('getCommitInfo', () => {
  it('reports files, times, and parsed added/removed lines', () => {
    const info = getCommitInfo(fx.repo, fx.commit2);
    expect(info.hash.length).toBe(40);
    expect(info.files).toEqual(['src/greet.ts']);
    expect(info.commitTime).toBeGreaterThan(0);
    expect(info.parentTime).toBeGreaterThan(0);
    expect(info.parentTime).toBeLessThan(info.commitTime);
    expect(info.addedLines.get('src/greet.ts')!.length).toBeGreaterThan(0);
    expect(info.removedLines.get('src/greet.ts')!.length).toBeGreaterThan(0);
  });
});

describe('parseBlameSpec', () => {
  it('parses a bare path with no line suffix', () => {
    expect(parseBlameSpec('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  it('parses a single-line spec', () => {
    expect(parseBlameSpec('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', lineStart: 42, lineEnd: 42 });
  });

  it('parses a line-range spec', () => {
    expect(parseBlameSpec('src/foo.ts:42-100')).toEqual({ path: 'src/foo.ts', lineStart: 42, lineEnd: 100 });
  });

  it('treats a non-numeric colon tail as part of the path', () => {
    // A Windows-style path whose last colon-tail is non-numeric stays whole.
    expect(parseBlameSpec('C:\\foo\\bar.ts')).toEqual({ path: 'C:\\foo\\bar.ts' });
  });

  it('parses a numeric tail after an interior colon in the path', () => {
    expect(parseBlameSpec('a:b.ts:12')).toEqual({ path: 'a:b.ts', lineStart: 12, lineEnd: 12 });
  });
});

describe('findSessionsForCommit', () => {
  it('attributes commit1 to the session that typed PAYLOAD_V1', async () => {
    const matches = await findSessionsForCommit(fx.commit1, {
      repoRoot: fx.repo,
      sessionsDir: fx.sessionsDir,
    });
    const ids = matches.map((m) => m.session);
    expect(ids).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    // Sessions that didn't touch commit1's content should not appear.
    expect(ids).not.toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(ids).not.toContain('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('attributes commit2 to both the top-level session and the subagent leaf', async () => {
    const matches = await findSessionsForCommit(fx.commit2, {
      repoRoot: fx.repo,
      sessionsDir: fx.sessionsDir,
    });
    const byId = new Map(matches.map((m) => [m.session, m]));
    expect(byId.has('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toBe(true);
    expect(byId.has('agent-deadbeefdeadbeef')).toBe(true);

    const sub = byId.get('agent-deadbeefdeadbeef')!;
    expect(sub.parent_session_id).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd');
    expect(sub.agent_type).toBe('Explore');

    const top = byId.get('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')!;
    expect(top.parent_session_id).toBeNull();
    expect(top.agent_type).toBeNull();
  });

  it('returns matches sorted chronologically asc by last_edit_at', async () => {
    const matches = await findSessionsForCommit(fx.commit2, {
      repoRoot: fx.repo,
      sessionsDir: fx.sessionsDir,
    });
    for (let i = 1; i < matches.length; i++) {
      expect(Date.parse(matches[i]!.last_edit_at)).toBeGreaterThanOrEqual(
        Date.parse(matches[i - 1]!.last_edit_at),
      );
    }
  });

  it('surviving_ratio never exceeds 1.0 even when tri-grams appear across files', async () => {
    // Synthesize a session that edited two commit files with overlapping
    // content. The pre-fix bug would double-count the shared tri-grams.
    const otherSessionsDir = tmpDir('git-attr-sessions-overflow-');
    const c2Ms = Date.parse(fx.commit2AuthorIso);

    // Add a second-file commit that mirrors PAYLOAD_V1's structure so
    // matching tri-grams exist across both files.
    const repo2 = tmpDir('git-attr-repo-overflow-');
    initRepo(repo2);
    commit(repo2, 'init', [{ file: 'README.md', content: '# t\n' }], isoMinutesAgo(30));
    const multiFileCommit = commit(
      repo2,
      'feat: two files at once',
      [
        { file: 'src/greet.ts', content: PAYLOAD_V1 },
        { file: 'src/greet-copy.ts', content: PAYLOAD_V1 },
      ],
      isoMinutesAgo(20),
    );
    const mcAuthorIso = execFileSync('git', ['show', '-s', '--pretty=%aI', multiFileCommit], {
      cwd: repo2,
      encoding: 'utf8',
    }).trim();
    const mcMs = Date.parse(mcAuthorIso);

    const eventsTwoFiles = [
      editEvent({
        tool: 'Write',
        filePath: path.join(repo2, 'src/greet.ts'),
        newString: PAYLOAD_V1,
        ts: new Date(mcMs - 6_000).toISOString(),
      }),
      editEvent({
        tool: 'Write',
        filePath: path.join(repo2, 'src/greet-copy.ts'),
        newString: PAYLOAD_V1,
        ts: new Date(mcMs - 5_000).toISOString(),
      }),
    ];
    writeSessionJsonl(otherSessionsDir, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', eventsTwoFiles);

    const matches = await findSessionsForCommit(multiFileCommit, {
      repoRoot: repo2,
      sessionsDir: otherSessionsDir,
    });
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.surviving_ratio).toBeLessThanOrEqual(1.0);
      expect(m.surviving_ratio).toBeGreaterThanOrEqual(0);
    }

    fs.rmSync(repo2, { recursive: true, force: true });
    fs.rmSync(otherSessionsDir, { recursive: true, force: true });
    // suppress unused warning
    void c2Ms;
  });

  it('exposes surviving_ratio alongside the boolean signal', async () => {
    const matches = await findSessionsForCommit(fx.commit1, {
      repoRoot: fx.repo,
      sessionsDir: fx.sessionsDir,
    });
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(typeof m.surviving_ratio).toBe('number');
      expect(typeof m.surviving_in_commit).toBe('boolean');
      // Consistency: boolean = (ratio >= 0.5)
      expect(m.surviving_in_commit).toBe(m.surviving_ratio >= 0.5);
    }
  });

  it('returns [] when sessions dir is missing', async () => {
    const matches = await findSessionsForCommit(fx.commit1, {
      repoRoot: fx.repo,
      sessionsDir: '/nonexistent/path/should/never/exist',
    });
    expect(matches).toEqual([]);
  });
});

describe('findSessionsForBlame', () => {
  it('attributes whole-file blame to sessions whose work survives at HEAD', async () => {
    // commit2 rewrote the middle of greet.ts to PAYLOAD_V2, but the function
    // signature and closing brace are identical to PAYLOAD_V1 — those lines
    // are still attributed to commit1 by git blame. So both session B
    // (typed PAYLOAD_V2) and session A (typed PAYLOAD_V1) appear.
    const matches = await findSessionsForBlame(
      [{ path: 'src/greet.ts' }],
      { repoRoot: fx.repo, sessionsDir: fx.sessionsDir },
    );
    const ids = matches.map((m) => m.session);
    expect(ids).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(ids).toContain('agent-deadbeefdeadbeef');
    expect(ids).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    // Session C touched a different file entirely; should NEVER appear.
    expect(ids).not.toContain('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('attributes a single-line blame to the commit that authored that line', async () => {
    // PAYLOAD_V2 line 3 (`const decorated = ...`) was added in commit2,
    // so only session B / the subagent should appear — session A's
    // PAYLOAD_V1 had no `decorated` line.
    const matches = await findSessionsForBlame(
      [{ path: 'src/greet.ts', lineStart: 3 }],
      { repoRoot: fx.repo, sessionsDir: fx.sessionsDir },
    );
    const ids = matches.map((m) => m.session);
    expect(ids).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(ids).not.toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('attributes a line range to all responsible commit-sessions', async () => {
    const matches = await findSessionsForBlame(
      [{ path: 'src/greet.ts', lineStart: 1, lineEnd: 5 }],
      { repoRoot: fx.repo, sessionsDir: fx.sessionsDir },
    );
    expect(matches.length).toBeGreaterThan(0);
    // All matches must be sessions whose lines survive at HEAD.
    for (const m of matches) {
      expect(m.surviving_ratio).toBeLessThanOrEqual(1.0);
    }
  });

  it('throws on inverted line ranges', async () => {
    await expect(
      findSessionsForBlame(
        [{ path: 'src/greet.ts', lineStart: 5, lineEnd: 1 }],
        { repoRoot: fx.repo, sessionsDir: fx.sessionsDir },
      ),
    ).rejects.toThrow(/range/);
  });

  it('respects the limit option', async () => {
    const matches = await findSessionsForBlame(
      [{ path: 'src/greet.ts' }],
      { repoRoot: fx.repo, sessionsDir: fx.sessionsDir, limit: 1 },
    );
    expect(matches.length).toBeLessThanOrEqual(1);
  });

  it('returns [] for empty specs', async () => {
    const matches = await findSessionsForBlame([], {
      repoRoot: fx.repo,
      sessionsDir: fx.sessionsDir,
    });
    expect(matches).toEqual([]);
  });
});

describe('Windows path normalization and Codex attribution', () => {
  it('normalizes Windows-native and slash edit paths without changing cwd slug inputs', async () => {
    const dir = tmpDir('recall-windows-edits-');
    try {
      for (const [root, raw, expected] of [
        ['D:\\work\\repo', 'D:\\work\\repo\\src\\a.ts', 'src/a.ts'],
        ['D:\\work\\repo', 'd:/work/repo/src/a.ts', 'src/a.ts'],
        ['d:/work/repo/', 'D:\\work\\repo\\src\\a.ts', 'src/a.ts'],
        ['D:\\work\\repo', 'src\\a.ts', 'src/a.ts'],
        ['D:\\work\\repo', 'D:/work/repository/src/a.ts', 'd:/work/repository/src/a.ts'],
        ['/work/repo', '/work/Repo/src/a.ts', process.platform === 'win32' ? 'src/a.ts' : '/work/Repo/src/a.ts'],
      ]) {
        const file = writeSessionJsonl(dir, 'windows', [editEvent({ tool: 'Edit', filePath: raw!, newString: 'a\nb\nc', ts: isoMinutesAgo(1) })]);
        expect((await extractSessionEdits(file, { repoRoot: root })).edits[0]!.file).toBe(expected);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('attributes Codex apply_patch to its metadata UUID for commit and blame, excluding another cwd', async () => {
    const dir = tmpDir('recall-codex-attribution-');
    try {
      const repo = path.join(dir, 'repo');
      const codexDir = path.join(dir, 'sessions');
      fs.mkdirSync(repo);
      initRepo(repo);
      commit(repo, 'base', [{ file: 'base.txt', content: 'base' }], isoMinutesAgo(10));
      const text = 'const first = 1;\nconst second = 2;\nexport const sum = first + second;\n';
      const hash = commit(repo, 'codex edit', [{ file: 'src/a.ts', content: text }], isoMinutesAgo(2));
      const patch = '*** Begin Patch\n*** Add File: src/a.ts\n' + text.trimEnd().split('\n').map(l => '+' + l).join('\n') + '\n*** End Patch';
      const event = (type: string, payload: object) => JSON.stringify({ type, timestamp: isoMinutesAgo(3), payload });
      const nested = path.join(codexDir, '2026', '09', '06');
      writeSessionJsonl(nested, 'rollout-date-valid', [
        event('session_meta', { id: 'codex-real-uuid', cwd: repo, agent_role: 'worker', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-uuid' } } } }),
        event('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call1', input: patch }),
      ]);
      writeSessionJsonl(nested, 'rollout-date-unrelated', [
        event('session_meta', { id: 'codex-unrelated', cwd: path.join(dir, 'other-repo') }),
        event('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call2', input: patch }),
      ]);
      const opts = { repoRoot: repo, sessionsDir: path.join(dir, 'missing-claude'), codexSessionsDir: codexDir };
      const matches = await findSessionsForCommit(hash, opts);
      expect(matches.map(m => m.session)).toEqual(['codex-real-uuid']);
      expect(matches[0]).toMatchObject({ matched_files: ['src/a.ts'], surviving_ratio: 1, parent_session_id: 'parent-uuid', agent_type: 'worker' });
      expect((await findSessionsForBlame([{ path: 'src/a.ts' }], opts)).map(m => m.session)).toEqual(['codex-real-uuid']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses Codex turn cwd changes and preserves streaming parse diagnostics', async () => {
    const dir = tmpDir('recall-codex-turn-cwd-');
    try {
      const event = (type: string, payload: object, timestamp = isoMinutesAgo(3)) => JSON.stringify({ type, timestamp, payload });
      const patch = '*** Begin Patch\n*** Update File: ../src/a.ts\n@@\n-old\n+one\n+two\n+three\n*** End Patch';
      const file = writeSessionJsonl(dir, 'rollout', [
        event('session_meta', { id: 'uuid', cwd: '/repo' }),
        event('turn_context', { cwd: '/repo/nested' }),
        '{broken',
        event('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'a', input: patch }),
        event('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'b', input: patch }, 'invalid'),
      ]);
      const trace = await extractSessionEdits(file, { repoRoot: '/repo' });
      expect(trace).toMatchObject({ sessionId: 'uuid', skippedLines: 1, skippedEvents: 1 });
      expect(trace.edits).toHaveLength(1);
      expect(trace.edits[0]).toMatchObject({ file: 'src/a.ts', content: 'one\ntwo\nthree' });
      expect(Number.isFinite(trace.edits[0]!.ts)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('platform-aware attribution file matching', () => {
  it('folds Windows relative-tail casing while preserving Git spelling and POSIX distinctions', async () => {
    const dir = tmpDir('recall-attribution-case-');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      const repo = path.join(dir, 'repo');
      const sessions = path.join(dir, 'sessions');
      fs.mkdirSync(repo);
      initRepo(repo);
      commit(repo, 'base', [{ file: 'base.txt', content: 'base' }], isoMinutesAgo(10));
      const text = 'const first = 1;\nconst second = 2;\nexport const sum = first + second;\n';
      const hash = commit(repo, 'mixed case path', [{ file: 'src/a.ts', content: text }], isoMinutesAgo(2));
      writeSessionJsonl(sessions, 'mixed-tail', [editEvent({
        tool: 'Write', filePath: repo.replace(/\\/g, '/') + '/SRC/A.TS', newString: text, ts: isoMinutesAgo(3),
      })]);
      const opts = { repoRoot: repo, sessionsDir: sessions };
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      const windows = await findSessionsForCommit(hash, opts);
      expect(windows).toHaveLength(1);
      expect(windows[0]).toMatchObject({ session: 'mixed-tail', matched_files: ['src/a.ts'], surviving_ratio: 1 });
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
      expect(await findSessionsForCommit(hash, opts)).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
