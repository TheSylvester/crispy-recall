/**
 * manifest — the upfront opt-out action checklist.
 *
 * Built from the PreflightReport, it lists every action the installer will
 * take, split into MANDATORY (informational, cannot be unchecked) and OPT-OUT
 * (deselectable; defaults ON). Consent is collected ONCE here, before any
 * mutation — there is no further per-item prompting downstream.
 *
 * @clack/prompts 0.7.0 has no per-option "disabled" flag, so MANDATORY items
 * are shown in a note() and only OPT-OUT items go into the multiselect — which
 * structurally enforces "MANDATORY cannot be unchecked".
 *
 * @module installer/manifest
 */

import { multiselect, note, isCancel, cancel } from '@clack/prompts';
import type { PreflightReport } from './preflight.js';

export interface ManifestItem {
  key: string;
  label: string;
  detail: string;
  mandatory: boolean;
  defaultSelected: boolean;
}

/** Build the action manifest from a pre-flight report. */
export function buildManifest(report: PreflightReport): ManifestItem[] {
  const items: ManifestItem[] = [];
  const gpuMode = report.runtime.gpu.plannedMode;

  // ---- MANDATORY (Claude Code) ----
  items.push({
    key: 'gpu',
    label: 'GPU: detect NVIDIA, live-test offload, adopt or fall back to CPU',
    detail: `planned: ${gpuMode === 'gpu' ? 'GPU offload (will live-test)' : 'CPU embeddings'}`,
    mandatory: true,
    defaultSelected: true,
  });
  items.push({
    key: 'stop-hook',
    label: 'Add the Stop (+ SubagentStop) hook to ~/.claude/settings.json',
    detail: 'indexes each finished session',
    mandatory: true,
    defaultSelected: true,
  });
  items.push({
    key: 'skill',
    label: 'Install the recall skill into ~/.claude/skills/recall/',
    detail: 'teaches the agent to search past sessions',
    mandatory: true,
    defaultSelected: true,
  });
  items.push({
    key: 'backfill',
    label: 'Run backfill in the background now',
    detail: 'indexes existing transcripts (detached)',
    mandatory: true,
    defaultSelected: true,
  });

  // ---- MANDATORY (Codex, only if detected) ----
  if (report.codex) {
    items.push({
      key: 'codex-skill',
      label: 'Install the recall skill into ~/.codex/skills/recall/',
      detail: 'Codex harness detected',
      mandatory: true,
      defaultSelected: true,
    });
  }

  // ---- OPT-OUT ----
  items.push({
    key: 'claudemd',
    label: 'Update ~/.claude/CLAUDE.md so Claude knows about Recall',
    detail: 'appends a short "## Recall" nudge',
    mandatory: false,
    defaultSelected: true,
  });
  if (report.codex) {
    items.push({
      key: 'codex-agentsmd',
      label: 'Update ~/.codex/AGENTS.md so Codex knows about Recall',
      detail: 'appends a short "## Recall" nudge',
      mandatory: false,
      defaultSelected: true,
    });
  }

  return items;
}

export interface RenderOptions {
  /** Suppress prompting (--yes or non-interactive): select all defaults, log them. */
  yes?: boolean;
  /** stdin is not a TTY → also suppress prompting. */
  interactive?: boolean;
  /** Sink for the suppressed-but-logged manifest line. */
  logLine?: (msg: string) => void;
}

/**
 * Render the manifest and return the set of selected action keys. Mandatory
 * keys are always included; only opt-out items can be toggled off.
 */
export async function renderManifest(items: ManifestItem[], opts: RenderOptions = {}): Promise<Set<string>> {
  const mandatory = items.filter((i) => i.mandatory);
  const optOut = items.filter((i) => !i.mandatory);
  const selected = new Set<string>(mandatory.map((i) => i.key));

  const suppress = opts.yes || opts.interactive === false;
  if (suppress) {
    for (const i of optOut) if (i.defaultSelected) selected.add(i.key);
    const log = opts.logLine ?? (() => {});
    log(`manifest (non-interactive): ${items.map((i) => `${i.key}${i.mandatory ? '*' : ''}`).join(', ')} (* = mandatory)`);
    return selected;
  }

  note(
    mandatory.map((i) => `• ${i.label}  (${i.detail})`).join('\n'),
    'Recall will do these (required)',
  );

  if (optOut.length > 0) {
    const result = await multiselect({
      message: 'Optional steps — uncheck any you want to skip:',
      options: optOut.map((i) => ({ value: i.key, label: i.label, hint: i.detail })),
      initialValues: optOut.filter((i) => i.defaultSelected).map((i) => i.key),
      required: false,
    });
    if (isCancel(result)) {
      cancel('Install cancelled.');
      process.exit(1);
    }
    for (const key of result as string[]) selected.add(key);
  }

  return selected;
}
