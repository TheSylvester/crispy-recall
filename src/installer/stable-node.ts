/**
 * stableNodePath — the upgrade-stable public Node path to pin in the Stop-hook
 * command, the skill's $RECALL_BIN, and the binding ABI marker.
 *
 * `process.execPath` resolves symlinks to the versioned path — on Homebrew that
 * is the Cellar (e.g. /opt/homebrew/Cellar/node/24.4.0/bin/node), which
 * `brew upgrade node && brew cleanup` DELETES, bricking every pinned recall
 * command after a routine upgrade. The public shim (/opt/homebrew/bin/node)
 * always points at the current version and survives upgrades. When a well-known
 * shim resolves to the SAME real binary we're running, prefer it; otherwise
 * (nvm, Windows, a bespoke layout) fall through to `process.execPath` unchanged
 * — a strict no-op off Homebrew, so Linux/WSL/Windows are unaffected.
 *
 * @module installer/stable-node
 */
import { existsSync, realpathSync } from 'node:fs';

/** Well-known upgrade-stable Homebrew node shims (arm64 + Intel prefixes). */
const DEFAULT_CANDIDATES = [
  '/opt/homebrew/bin/node',           // Apple Silicon Homebrew
  '/opt/homebrew/opt/node/bin/node',
  '/usr/local/bin/node',              // Intel Homebrew
  '/usr/local/opt/node/bin/node',
];

export interface StableNodeOptions {
  /** The running interpreter to match against (defaults to process.execPath). */
  execPath?: string;
  /** Candidate shim paths to consider (defaults to the Homebrew shims). */
  candidates?: string[];
}

/**
 * Return the first candidate shim that exists AND resolves (realpath) to the
 * SAME binary as `execPath` — the upgrade-stable public path. If none matches,
 * return `execPath` unchanged (non-Homebrew setups are a no-op).
 */
export function stableNodePath(opts: StableNodeOptions = {}): string {
  const execPath = opts.execPath ?? process.execPath;
  const candidates = opts.candidates ?? DEFAULT_CANDIDATES;

  let realExec: string;
  try {
    realExec = realpathSync(execPath);
  } catch {
    return execPath; // execPath should always resolve; be defensive anyway
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && realpathSync(candidate) === realExec) {
        return candidate;
      }
    } catch {
      // Dangling symlink / race between existsSync and realpathSync — non-match.
    }
  }
  return execPath;
}
