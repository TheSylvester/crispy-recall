/**
 * Hub token store — `~/.recall/hub-tokens.json` (spec §2.1, §2.3 Auth).
 *
 * One bearer token per satellite host. The file holds ONLY `sha256(token)`;
 * the token itself is printed once at issue time and never stored. The
 * daemon reads the file PER REQUEST (stat, re-parse on change), so a revoke
 * or rotate is effective on the next request with no restart.
 *
 * @module hub/tokens
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { recallRoot } from '../paths.js';
import { HOST_RE } from './protocol.js';
import { atomicWriteFile } from './runtime.js';

export function hubTokensPath(): string {
  return join(recallRoot(), 'hub-tokens.json');
}

interface TokenEntry { host: string; createdAt: string }
interface TokenFile { v: 1; tokens: Record<string, TokenEntry> }

const HEX64 = /^[0-9a-f]{64}$/;

function parseTokenFile(text: string): TokenFile | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const f = parsed as Record<string, unknown>;
  if (f['v'] !== 1 || !f['tokens'] || typeof f['tokens'] !== 'object') return null;
  const tokens: Record<string, TokenEntry> = {};
  for (const [hash, entry] of Object.entries(f['tokens'] as Record<string, unknown>)) {
    if (!HEX64.test(hash) || !entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e['host'] !== 'string') continue;
    tokens[hash] = { host: e['host'], createdAt: typeof e['createdAt'] === 'string' ? e['createdAt'] : '' };
  }
  return { v: 1, tokens };
}

function readTokenFile(): TokenFile {
  try {
    return parseTokenFile(readFileSync(hubTokensPath(), 'utf-8')) ?? { v: 1, tokens: {} };
  } catch {
    return { v: 1, tokens: {} };
  }
}

function writeTokenFile(f: TokenFile): void {
  atomicWriteFile(hubTokensPath(), JSON.stringify(f, null, 2) + '\n');
}

export function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Issue (or rotate) the token for `host`. Returns the plaintext token — the
 * ONLY time it exists outside the caller's terminal.
 */
export function issueHubToken(host: string): string {
  if (!HOST_RE.test(host)) throw new Error(`invalid host name "${host}" (expected ${HOST_RE.source})`);
  const token = randomBytes(32).toString('hex');
  const f = readTokenFile();
  for (const [hash, entry] of Object.entries(f.tokens)) {
    if (entry.host === host) delete f.tokens[hash];
  }
  f.tokens[sha256Hex(token)] = { host, createdAt: new Date().toISOString() };
  writeTokenFile(f);
  return token;
}

/** Remove every entry for `host`. Returns true when one existed. */
export function revokeHubToken(host: string): boolean {
  const f = readTokenFile();
  let removed = false;
  for (const [hash, entry] of Object.entries(f.tokens)) {
    if (entry.host === host) { delete f.tokens[hash]; removed = true; }
  }
  if (removed) writeTokenFile(f);
  return removed;
}

/** Hosts holding a token, sorted. */
export function listHubTokenHosts(): string[] {
  return [...new Set(Object.values(readTokenFile().tokens).map((e) => e.host))].sort();
}

/** Delete the file entirely (uninstall). */
export function removeHubTokens(): void {
  try { if (existsSync(hubTokensPath())) unlinkSync(hubTokensPath()); } catch { /* ignore */ }
}

/**
 * Per-request authenticator. `statSync` on every call; re-parse only when
 * `(mtimeMs, size, ino)` changed. Missing or unparseable → zero valid tokens.
 */
export class TokenStore {
  private sig: string | null = null;
  private entries: Array<{ hash: Buffer; host: string }> = [];

  private refresh(): void {
    let st;
    try {
      st = statSync(hubTokensPath());
    } catch {
      this.sig = null;
      this.entries = [];
      return;
    }
    const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (sig === this.sig) return;
    let parsed: TokenFile | null = null;
    try { parsed = parseTokenFile(readFileSync(hubTokensPath(), 'utf-8')); } catch { parsed = null; }
    this.entries = parsed
      ? Object.entries(parsed.tokens).map(([hash, e]) => ({ hash: Buffer.from(hash, 'hex'), host: e.host }))
      : [];
    this.sig = sig;
  }

  /** Number of valid entries as of the last refresh. */
  count(): number {
    this.refresh();
    return this.entries.length;
  }

  /**
   * `Authorization: Bearer <token>` → host, or null. The host comes from the
   * matching entry, never from the request. Every stored hash is compared
   * (no early exit) with `timingSafeEqual` on 32-byte buffers.
   */
  authenticate(authorization: string | undefined): string | null {
    this.refresh();
    if (typeof authorization !== 'string') return null;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!m) return null;
    const presented = createHash('sha256').update(m[1]!, 'utf8').digest();
    let host: string | null = null;
    for (const entry of this.entries) {
      if (entry.hash.length === 32 && timingSafeEqual(entry.hash, presented) && host === null) host = entry.host;
    }
    return host;
  }
}
