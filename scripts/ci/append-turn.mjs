#!/usr/bin/env node
/**
 * Append one fresh user+assistant turn (new, unique uuids) to an existing seeded
 * transcript, for the Stop-hook leg of the macOS smoke workflow. The hook
 * re-ingests the named session; recall's INSERT-OR-IGNORE-by-uuid means only the
 * newly appended rows land, so the message count must grow by exactly the turns
 * we add — that row-count-grew check is the real proof the hook worked (the hook
 * exits 0 even on a malformed payload, so its exit code proves nothing).
 *
 * Usage: node append-turn.mjs --session-path <file> --session-id <sid> \
 *          --token "wombat tuesday marmalade"
 */
import { appendFileSync } from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const path = arg('session-path');
const sid = arg('session-id');
const token = arg('token', 'wombat tuesday marmalade');
if (!path || !sid) {
  console.error('append-turn: --session-path and --session-id are required');
  process.exit(2);
}

const ts = '2026-07-05T23:59:00.000Z';
const user = JSON.stringify({
  type: 'user',
  uuid: `${sid}-append-u`,
  parentUuid: null,
  sessionId: sid,
  cwd: process.cwd(),
  timestamp: ts,
  message: { role: 'user', content: `Follow-up: please also verify the ${token} edge case that only appears under concurrent load.` },
});
const assistant = JSON.stringify({
  type: 'assistant',
  uuid: `${sid}-append-a`,
  parentUuid: null,
  sessionId: sid,
  cwd: process.cwd(),
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text: `Verified the ${token} edge case and added a guard plus a concurrent-load regression test to cover it.` }] },
});

appendFileSync(path, user + '\n' + assistant + '\n');
console.log(`appended 2 turns (token="${token}") to ${path}`);
