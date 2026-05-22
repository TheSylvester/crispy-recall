/**
 * Adapter Types — minimal shared types for the vendor JSONL readers.
 *
 * jsonl-reader.ts (claude + codex) reference `UserPromptInfo` and
 * `UserActivityScanResult`. The standalone has no full adapter framework;
 * these two types are the only pieces the recall slice needs, so they live
 * here as a tiny shim.
 *
 * @module adapter-types
 */

/** User prompt metadata extracted during activity scanning. */
export interface UserPromptInfo {
  timestamp: string;
  preview: string;
  offset: number;
  uuid?: string;
}

/** Result from scanning user activity in a session file. */
export interface UserActivityScanResult {
  prompts: UserPromptInfo[];
  offset: number;
}
