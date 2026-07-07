/**
 * uninstall — cleanly reverse the install.
 *
 * Removes the recall skill, the Stop + SubagentStop hook entries (Claude and
 * Codex), and the CLAUDE.md / AGENTS.md nudge. Leaves ~/.recall/ (DB +
 * config.json) intact unless `--purge` is passed.
 *
 * @module installer/uninstall
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { removeStopHook, removeStatusLine } from './settings-merge.js';
import { clearStatuslineConfig } from './config.js';
import { removeNudge } from './claudemd-nudge.js';
import {
  claudeSettingsPath, claudeMdPath, claudeRecallSkillPath,
  codexHooksPath, codexAgentsPath, codexRecallSkillPath,
} from './preflight.js';
import { recallRoot } from '../paths.js';
import { closeDb } from '../db.js';
import { log } from '../log.js';

export interface UninstallOptions { purge?: boolean; json?: boolean }
export interface UninstallResult { removed: string[]; purged: boolean }

export function runUninstall(opts: UninstallOptions = {}): UninstallResult {
  const removed: string[] = [];

  // Skill directories (the recall/ folder containing SKILL.md).
  for (const skillFile of [claudeRecallSkillPath(), codexRecallSkillPath()]) {
    const dir = dirname(skillFile);
    if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); removed.push(dir); }
  }

  // Hook entries (path-independent removal).
  if (removeStopHook(claudeSettingsPath()).changed) removed.push(claudeSettingsPath());
  if (removeStopHook(codexHooksPath()).changed) removed.push(codexHooksPath());

  // CLAUDE.md / AGENTS.md nudge.
  if (removeNudge(claudeMdPath()).changed) removed.push(claudeMdPath());
  if (removeNudge(codexAgentsPath()).changed) removed.push(codexAgentsPath());

  // statusLine (Claude-only; Codex has none). Ownership via isRecallStatusLine,
  // so it cleans up even if config.json is gone. BEFORE --purge deletes ~/.recall
  // so readConfig() is still available and settings.json is left clean. The
  // config record is cleared unconditionally (even when the user had already
  // replaced recall's statusLine) so doctor/reinstall never act on a stale one.
  if (removeStatusLine(claudeSettingsPath()).changed) removed.push(claudeSettingsPath());
  clearStatuslineConfig();

  // ~/.recall/ only on --purge (includes DB + config.json).
  let purged = false;
  if (opts.purge) {
    closeDb(); // release the sqlite handle before removing the tree
    if (existsSync(recallRoot())) { rmSync(recallRoot(), { recursive: true, force: true }); removed.push(recallRoot()); }
    purged = true;
  }

  log({ source: 'installer/uninstall', level: 'info', summary: `uninstall removed ${removed.length} targets (purge=${purged})` });
  return { removed, purged };
}
