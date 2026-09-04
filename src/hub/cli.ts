/**
 * `recall hub …` subcommands (spec §2.1): serve, token, status,
 * install-service. Entered from recall.ts BEFORE `maybeRunT1()`.
 *
 * @module hub/cli
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { getDb } from '../db.js';
import { readHubConfig, writeHubConfig } from '../installer/config.js';
import { dbPath, logsDir, remoteRoot, runDir } from '../paths.js';
import { getBinaryPath, getModelPath } from '../recall/embedder.js';
import { mirrorHostSummary, mirrorHosts } from './mirror.js';
import { WIRE_VERSION } from './protocol.js';
import { hubDaemonAlive, hubLogPath, readHostRecords, readPackageVersion } from './runtime.js';
import { checkBindPolicy, startHubServer } from './server.js';
import { runInstallService } from './service.js';
import { issueHubToken, listHubTokenHosts, revokeHubToken } from './tokens.js';

export const DEFAULT_HUB_BIND = '127.0.0.1';
export const DEFAULT_HUB_PORT = 7877;

export interface HubCliFlags {
  bind?: string;
  port?: string;
  detach: boolean;
  publicOk: boolean;
  host?: string;
  revoke?: string;
  json: boolean;
}

export function hubUsage(): string {
  return [
    'Usage:',
    '  recall hub serve [--bind <addr>] [--port <n>] [--detach] [--i-know-this-is-public]',
    '  recall hub token --host <name> | --revoke <name>',
    '  recall hub status [--json]',
    '  recall hub install-service',
  ].join('\n');
}

export async function runHubCommand(sub: string | undefined, f: HubCliFlags): Promise<number> {
  switch (sub) {
    case 'serve': return runServe(f);
    case 'token': return runToken(f);
    case 'status': return runStatus(f.json);
    case 'install-service': {
      const r = runInstallService();
      for (const m of r.messages) console.log(m);
      return r.code;
    }
    default:
      console.error(sub ? `recall hub: unknown subcommand "${sub}"` : 'recall hub: a subcommand is required');
      console.error(hubUsage());
      return 1;
  }
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function runServe(f: HubCliFlags): Promise<number> {
  const config = readHubConfig();

  let port: number;
  if (f.port !== undefined) {
    if (!/^\d+$/.test(f.port) || Number(f.port) > 65535) {
      console.error(`recall hub: --port must be an integer 0-65535 (got "${f.port}")`);
      return 1;
    }
    port = Number(f.port);
  } else {
    port = config?.port ?? DEFAULT_HUB_PORT;
  }
  // An ABSENT `bind` key in an existing config is ANY (§2.2); no config at all
  // means the loopback default.
  const bind: string | undefined = f.bind !== undefined ? f.bind : (config ? config.bind : DEFAULT_HUB_BIND);

  // Persist BEFORE binding when given; a resolved `--port 0` is never persisted.
  if (f.bind !== undefined || (f.port !== undefined && port > 0)) {
    writeHubConfig({
      bind: bind ?? '',
      port: port > 0 ? port : (config?.port ?? DEFAULT_HUB_PORT),
      installedAt: config?.installedAt ?? new Date().toISOString(),
    });
  }

  // Preflight: the daemon serves nothing without the runtime and the DB.
  const missing: string[] = [];
  if (!existsSync(getBinaryPath())) missing.push(`embedding binary (${getBinaryPath()})`);
  if (!existsSync(getModelPath())) missing.push(`model (${getModelPath()})`);
  if (!existsSync(dbPath())) missing.push(`database (${dbPath()})`);
  if (missing.length) {
    console.error(`recall hub: not installed on this machine — missing ${missing.join(', ')}. Run \`recall install\`, then \`recall doctor\`.`);
    return 1;
  }

  const policy = checkBindPolicy(bind, { publicOk: f.publicOk, tokenCount: listHubTokenHosts().length });
  if (!policy.ok) {
    console.error(policy.message);
    return 1;
  }

  if (f.detach) {
    mkdirSync(runDir(), { recursive: true });
    mkdirSync(logsDir(), { recursive: true });
    const logFd = openSync(hubLogPath(), 'a');
    const args = [process.argv[1]!, 'hub', 'serve', '--bind', policy.bind, '--port', String(port)];
    if (f.publicOk) args.push('--i-know-this-is-public');
    const child = spawn(process.execPath, args, {
      detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: { ...process.env },
    });
    child.unref();
    console.log(`recall hub: started in the background (pid ${child.pid ?? '?'}) — log: ${hubLogPath()}`);
    return 0;
  }

  // Open the database ONCE before listen: U0's codex re-key gate throws on
  // every normal open until the marker is written, and without this the
  // daemon would start and every push and query would 500.
  try {
    getDb(dbPath());
  } catch (e) {
    if ((e as Error).name === 'MigrationPendingError') {
      console.error('recall hub: database migration pending — run `recall install` (or `recall repair --rekey-codex`) on the hub before starting the daemon');
      return 1;
    }
    throw e;
  }

  let handle;
  try {
    handle = await startHubServer({
      bind: policy.bind, port, installSignalHandlers: true, exitOnShutdown: true,
    });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.log(`recall hub: listening on ${handle.address}:${handle.port} (pid ${process.pid}, wire ${WIRE_VERSION})`);
  if (policy.cls === 'any') console.error('recall hub: WARNING — bound to every interface; only a valid token can reach the index.');
  // Foreground for systemd: never resolves; the signal handlers exit the process.
  return new Promise<number>(() => { /* runs until a signal */ });
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

function runToken(f: HubCliFlags): number {
  if (f.revoke !== undefined) {
    const removed = revokeHubToken(f.revoke);
    console.log(removed
      ? `recall hub: token for "${f.revoke}" revoked — effective immediately, no restart needed`
      : `recall hub: no token for "${f.revoke}"`);
    return 0;
  }
  if (f.host === undefined) {
    console.error('recall hub token: --host <name> or --revoke <name> is required');
    return 1;
  }
  let token: string;
  try {
    token = issueHubToken(f.host);
  } catch (e) {
    console.error(`recall hub token: ${(e as Error).message}`);
    return 1;
  }
  const config = readHubConfig();
  const hubUrl = `http://${config?.bind || DEFAULT_HUB_BIND}:${config?.port ?? DEFAULT_HUB_PORT}`;
  console.log(`recall hub: token for "${f.host}" (shown once, never stored in the clear):`);
  console.log(token);
  console.log(`On the satellite: recall install --hub ${hubUrl} --token - (paste the token on stdin)`);
  console.log('The token is effective immediately, no restart needed.');
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface HubStatusReport {
  configured: { bind: string | null; port: number } | null;
  daemon: {
    alive: boolean; pid: number | null; bind: string | null; address: string | null; port: number | null;
    startedAt: string | null; uptimeSec: number | null;
  };
  version: string;
  wire: number;
  tokens: string[];
  remoteRoot: string;
  hosts: Array<{
    host: string; files: number; bytes: number; sidecarless: number;
    lastPushAt: string | null; lastQueryAt: string | null; lastFullManifestAt: string | null; refusedCollisions: number;
  }>;
}

export function getHubStatus(): HubStatusReport {
  const config = readHubConfig();
  const { alive, record } = hubDaemonAlive();
  const records = readHostRecords();
  const hostNames = [...new Set([...mirrorHosts(), ...Object.keys(records)])].sort();
  return {
    configured: config ? { bind: config.bind ?? null, port: config.port } : null,
    daemon: {
      alive,
      pid: record?.pid ?? null,
      bind: record?.bind ?? null,
      address: record?.address ?? record?.bind ?? null,
      port: record?.port ?? null,
      startedAt: record?.startedAt ?? null,
      uptimeSec: alive && record ? Math.max(0, Math.round((Date.now() - Date.parse(record.startedAt)) / 1000)) : null,
    },
    version: readPackageVersion(),
    wire: WIRE_VERSION,
    tokens: listHubTokenHosts(),
    remoteRoot: remoteRoot(),
    hosts: hostNames.map((host) => {
      const s = mirrorHostSummary(host);
      const r = records[host];
      return {
        host, files: s.files, bytes: s.bytes, sidecarless: s.sidecarless,
        lastPushAt: r?.lastPushAt ?? null, lastQueryAt: r?.lastQueryAt ?? null,
        lastFullManifestAt: r?.lastFullManifestAt ?? null, refusedCollisions: r?.refusedCollisions ?? 0,
      };
    }),
  };
}

function runStatus(json: boolean): number {
  const s = getHubStatus();
  if (json) { console.log(JSON.stringify(s, null, 2)); return 0; }
  console.log('recall hub status');
  console.log('-----------------');
  console.log(`Configured:    ${s.configured ? `${s.configured.bind ?? '(absent bind = ANY)'}:${s.configured.port}` : 'none (defaults 127.0.0.1:7877)'}`);
  console.log(`Daemon:        ${s.daemon.alive ? `alive pid ${s.daemon.pid}, resolved ${s.daemon.address}:${s.daemon.port}, up ${s.daemon.uptimeSec}s` : 'not running'}`);
  console.log(`Version/wire:  ${s.version} / ${s.wire}`);
  console.log(`Tokens:        ${s.tokens.length ? s.tokens.join(', ') : 'none'}`);
  console.log(`Mirror root:   ${s.remoteRoot}`);
  if (s.hosts.length === 0) console.log('Hosts:         none');
  for (const h of s.hosts) {
    console.log(`Host ${h.host}:`);
    console.log(`  files ${h.files}, bytes ${h.bytes}, sidecar-less ${h.sidecarless}`);
    console.log(`  last push ${h.lastPushAt ?? 'never'}, last query ${h.lastQueryAt ?? 'never'}`);
    console.log(`  last full manifest ${h.lastFullManifestAt ?? 'never'}, refused collisions ${h.refusedCollisions}`);
  }
  return 0;
}
