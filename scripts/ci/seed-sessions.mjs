#!/usr/bin/env node
/**
 * Seed synthetic Claude Code session transcripts for the macOS smoke workflow.
 *
 * Writes N `.jsonl` files under `<home>/.claude/projects/<slug>/<sessionId>.jsonl`
 * — the exact layout recall's backfill globs (`projects/**​/*.jsonl`, see
 * src/recall/mtime-scan.ts + src/session-manager-shim.ts). Each session gets
 * three turns whose text bodies are ALL ≥ 50 chars (MIN_EMBED_CHARS, so every
 * message is eligible to embed) and carry a distinctive token phrase so the
 * search assertions cannot collide with anything else on a clean runner.
 *
 * recall keys a message row on its `uuid` (message_id PK, opaque TEXT — no UUID
 * parsing) and derives the row `session_id` from the FILENAME stem, so the
 * in-file `sessionId` is cosmetic; we still set it to match the filename.
 *
 * Emits a JSON summary { cwd, slug, sessions:[{id,path}] } on stdout so the
 * workflow can drive the Stop-hook leg against a known session id + path.
 *
 * Usage: node seed-sessions.mjs --token "xylophone quantum cheese" \
 *          --sessions 2 --cwd /path/used/as/project_id [--home $HOME]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const token = arg('token', 'xylophone quantum cheese');
const count = parseInt(arg('sessions', '2'), 10);
const home = arg('home', homedir());
const cwd = arg('cwd', join(home, 'recall-ci-project'));

// Claude's own slug convention: every non-alphanumeric char in the absolute cwd
// becomes '-' (src/git-attribution.ts cwdToProjectSlug). Backfill discovery does
// not actually depend on the slug (it globs `**`), but we mirror it for realism.
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const dir = join(home, '.claude', 'projects', slug);
mkdirSync(dir, { recursive: true });

const summary = { cwd, slug, sessions: [] };

for (let s = 0; s < count; s++) {
  const sessionId = `ci-smoke-session-${s}`;
  const file = join(dir, `${sessionId}.jsonl`);
  const ts = `2026-07-05T1${s}:00:00.000Z`;

  const user = (n, text) =>
    JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u${n}`,
      parentUuid: null,
      sessionId,
      cwd,
      timestamp: ts,
      message: { role: 'user', content: text },
    });
  const assistant = (n, text) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a${n}`,
      parentUuid: null,
      sessionId,
      cwd,
      timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

  const lines = [
    user(1, `Please help me tune the ${token} indexing pipeline so retrieval stays deterministic across CI runs.`),
    assistant(1, `I tuned the ${token} pipeline: fixed the ordering, added a stable sort, and documented the retrieval contract.`),
    user(2, `Great — now add a regression test that locks the ${token} behaviour so future refactors cannot silently break it.`),
  ];

  writeFileSync(file, lines.join('\n') + '\n');
  summary.sessions.push({ id: sessionId, path: file });
}

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
