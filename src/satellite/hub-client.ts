/**
 * hub-client — the satellite's one HTTP seam to its hub (spec §2.3, D4).
 *
 * In-house transport: `node:http` (`node:https` only when the owner points the
 * satellite at a TLS terminator — the hub itself ships no TLS in v1). No
 * framework, no third-party client, so package.json keeps its single runtime
 * dependency.
 *
 * Every authenticated request carries the wire headers; a response whose
 * `X-Recall-Version` major.minor differs from ours produces exactly ONE stderr
 * warning per process (§6).
 *
 * @module satellite/hub-client
 */

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HEADER_VERSION, HEADER_WIRE, WIRE_VERSION } from '../hub/protocol.js';
import { getVersion as packageVersion } from '../version.js';

/** Default socket-connect budget. */
export const CONNECT_TIMEOUT_MS = 3000;
/** Default per-request budget once connected. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A transport failure (never an HTTP status). `reason` is user-facing. */
export class HubTransportError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'HubTransportError'; }
}

export interface HubResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface HubRequestOptions {
  method: string;
  /** Path with query string, e.g. `/v1/push/append?vendor=claude&path=…`. */
  path: string;
  token?: string | null;
  headers?: Record<string, string>;
  body?: Buffer | string;
  connectTimeoutMs?: number;
  timeoutMs?: number;
}

/** Package version — the build-time define, else a package.json fallback (§6).
 *  A staged satellite bundle now reports a real version, so `maybeWarnVersion`
 *  is no longer silenced by an `unknown` local side. */
export function localVersion(): string {
  return packageVersion();
}

/** Join a hub base URL with an absolute path, tolerating a trailing slash. */
export function hubEndpoint(hubUrl: string, path: string): string {
  return hubUrl.replace(/\/+$/, '') + path;
}

let warnedVersion = false;

/** One stderr line per process when the hub's major.minor differs from ours. */
export function maybeWarnVersion(headers: IncomingHttpHeaders): void {
  if (warnedVersion) return;
  const remote = headers[HEADER_VERSION];
  if (typeof remote !== 'string' || remote.length === 0) return;
  const local = localVersion();
  const mm = (v: string) => v.split('.').slice(0, 2).join('.');
  if (local === 'unknown' || remote === 'unknown') return;
  if (mm(local) === mm(remote)) return;
  warnedVersion = true;
  process.stderr.write(`recall: hub runs recall ${remote}, this satellite runs ${local}\n`);
}

/** Test/observability hook — reset the once-per-process warning latch. */
export function _resetVersionWarning(): void { warnedVersion = false; }

/**
 * Perform one hub request. Resolves on ANY HTTP status (the caller decides);
 * rejects with a HubTransportError only when no response was received.
 */
export function hubRequest(hubUrl: string, opts: HubRequestOptions): Promise<HubResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(hubEndpoint(hubUrl, opts.path));
    } catch {
      reject(new HubTransportError(`invalid hub url ${hubUrl}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const headers: Record<string, string> = {
      [HEADER_WIRE]: String(WIRE_VERSION),
      [HEADER_VERSION]: localVersion(),
      ...(opts.headers ?? {}),
    };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const body = opts.body === undefined
      ? undefined
      : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf-8');
    if (body) headers['content-length'] = String(body.byteLength);

    // node reuses agent sockets, so our per-request socket listeners MUST be
    // removed when the request settles — otherwise a multi-chunk push piles up
    // listeners on one socket (MaxListenersExceededWarning, then a real leak).
    let cleanup = () => {};
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { req.destroy(); } catch { /* already gone */ }
      reject(new HubTransportError(reason));
    };

    const req = doRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const response = { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) };
          maybeWarnVersion(response.headers);
          resolve(response);
        });
        res.on('error', (e) => fail(`response error: ${(e as Error).message}`));
      },
    );

    // Two-stage budget: the connect window is short so an unreachable hub is
    // reported in seconds, then the socket gets the (much longer) per-request
    // window for the transfer itself.
    let connected = false;
    req.on('socket', (socket) => {
      const onConnect = () => {
        connected = true;
        socket.setTimeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
      };
      const onTimeout = () => fail(connected ? 'request timed out' : 'connection timed out');
      cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('timeout', onTimeout);
        socket.setTimeout(0);
      };
      socket.setTimeout(opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      socket.once('connect', onConnect);
      // A reused/already-connected socket never emits 'connect'.
      if ((socket as unknown as { connecting?: boolean }).connecting === false) onConnect();
      socket.on('timeout', onTimeout);
    });
    req.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      fail(code ? `${code} (${(e as Error).message})` : (e as Error).message);
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Parse a JSON response body; returns null when it is not JSON. */
export function parseJson<T>(res: HubResponse): T | null {
  try { return JSON.parse(res.body.toString('utf-8')) as T; } catch { return null; }
}
