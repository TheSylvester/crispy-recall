/**
 * stub-hub — a §2.3 hub, implemented literally, for satellite tests.
 *
 * Binds 127.0.0.1:0 only. Stores appended bytes in memory (no sidecars, no
 * database, no ingest), and RECORDS every request with its decoded
 * `X-Recall-Meta` so a test can assert exactly what the satellite sent.
 *
 * Unit U2 builds the real daemon in parallel against the same frozen §2.3;
 * this stub is what U3 develops against.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {
  HEADER_META, HEADER_STALE, HEADER_VERSION, HEADER_WIRE, MAX_APPEND_BYTES,
  MAX_MANIFEST_BODY, WIRE_VERSION, decodeMeta, parseVendor, validateRelPath, type AppendMeta,
} from '../../src/hub/protocol.js';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body for the JSON endpoints. */
  json?: unknown;
  /** Raw body for `PUT /v1/push/append`. */
  bytes?: Buffer;
  /** Decoded `X-Recall-Meta` for `PUT /v1/push/append`. */
  meta?: AppendMeta | Error;
  status: number;
}

export interface StubHubOptions {
  /** Wire version this hub speaks. Anything else gets 426. */
  wire?: number;
  /** `X-Recall-Version` the hub reports. */
  version?: string;
  /** Host name bound to the token. */
  host?: string;
  /** Answer every manifest with `fullSweepDue: true`. */
  fullSweepDue?: boolean;
  /** Canned `POST /v1/query` reply. */
  query?: { stdout?: string; stderr?: string; exit?: number; stale?: boolean };
  /** Force a status on `PUT /v1/push/append` (e.g. 426) instead of serving it. */
  appendStatus?: number;
  /** Hold each manifest reply this long (tests the caller's run budget). */
  manifestDelayMs?: number;
  /** Statuses to answer successive manifests with; 200 serves normally. */
  manifestStatuses?: number[];
  /** Answer every manifest 200 with this raw (non-JSON) body. */
  manifestGarbage?: string;
  /** 413 any manifest carrying more than this many files. */
  manifestMaxFiles?: number;
}

export interface StubHub {
  url: string;
  token: string;
  host: string;
  requests: RecordedRequest[];
  /** Mirror content keyed `<vendor>/<rel>`. */
  files: Map<string, Buffer>;
  /** Seed a file so the hub reports a non-zero offset. */
  seed(vendor: string, rel: string, bytes: Buffer | string): void;
  /** Every request whose path is `p`. */
  by(p: string): RecordedRequest[];
  options: StubHubOptions;
  close(): Promise<void>;
  server: Server;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startStubHub(opts: StubHubOptions = {}): Promise<StubHub> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const host = opts.host ?? 'test-satellite';
  const requests: RecordedRequest[] = [];
  const files = new Map<string, Buffer>();
  const wire = opts.wire ?? WIRE_VERSION;
  const version = opts.version ?? '0.3.1';

  const server = createServer((req, res) => { void handle(req, res); });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rec: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers as Record<string, string | undefined>,
      status: 0,
    };
    requests.push(rec);

    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      rec.status = status;
      res.writeHead(status, { 'content-type': 'application/json', [HEADER_VERSION]: version, ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (url.pathname === '/v1/health') {
      send(200, { ok: true, version, wire, hub: host, runtime: { binary: true, model: true } });
      return;
    }

    // Wire check, on all three authenticated endpoints.
    if (String(req.headers[HEADER_WIRE] ?? '') !== String(wire)) {
      send(426, { wire, version });
      return;
    }
    // Bearer check.
    const auth = String(req.headers['authorization'] ?? '');
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (createHash('sha256').update(presented).digest('hex') !== tokenHash) {
      send(401, { error: 'unauthorized' });
      return;
    }

    if (url.pathname === '/v1/push/manifest' && req.method === 'POST') {
      const raw = await readBody(req);
      rec.bytes = raw;
      if (raw.byteLength > MAX_MANIFEST_BODY) { send(413, { error: 'body too large' }); return; }
      const body = JSON.parse(raw.toString('utf-8') || '{}') as {
        vendor?: string; full?: boolean; files?: Array<{ path: string; size: number }>;
      };
      rec.json = body;
      if (opts.manifestMaxFiles !== undefined && (body.files ?? []).length > opts.manifestMaxFiles) {
        send(413, { error: 'too many files' });
        return;
      }
      if (opts.manifestDelayMs) await new Promise((r) => setTimeout(r, opts.manifestDelayMs));
      const forced = opts.manifestStatuses?.shift();
      if (forced !== undefined && forced !== 200) { send(forced, { error: 'forced' }); return; }
      if (opts.manifestGarbage !== undefined) {
        rec.status = 200;
        res.writeHead(200, { 'content-type': 'application/json', [HEADER_VERSION]: version });
        res.end(opts.manifestGarbage);
        return;
      }
      const out = (body.files ?? []).map((f) => {
        const stored = files.get(`${body.vendor}/${f.path}`);
        const offset = stored ? stored.byteLength : 0;
        return offset > f.size ? { path: f.path, offset: 0, reset: true as const } : { path: f.path, offset };
      });
      send(200, { host, fullSweepDue: opts.fullSweepDue === true, files: out });
      return;
    }

    if (url.pathname === '/v1/push/append' && req.method === 'PUT') {
      const vendor = url.searchParams.get('vendor') ?? '';
      const rel = url.searchParams.get('path') ?? '';
      const offset = Number(url.searchParams.get('offset'));
      const metaHeader = String(req.headers[HEADER_META] ?? '');
      rec.meta = decodeMeta(metaHeader);
      // §2.3: 411 when Content-Length is absent OR non-numeric. Validate the
      // RAW header — `Number('')` is 0, so an empty header would pass a
      // numeric check that the spec says must fail.
      const rawLen = req.headers['content-length'];
      if (typeof rawLen !== 'string' || !/^\d+$/.test(rawLen)) {
        send(411, { error: 'content-length required' });
        return;
      }
      const len = Number(rawLen);
      if (len > MAX_APPEND_BYTES) { send(413, { error: 'body too large' }); return; }
      const bytes = await readBody(req);
      rec.bytes = bytes;
      if (opts.appendStatus) { send(opts.appendStatus, { error: 'forced' }); return; }
      // Merge-integration: U2's canonical protocol types the vendor, so the
      // stub narrows the query-string value first (unknown vendor → 400, the
      // same outcome U3's provisional validateRelPath produced).
      const hubVendor = parseVendor(vendor);
      if (!hubVendor) { send(400, { error: `unknown vendor: ${vendor}` }); return; }
      const check = validateRelPath(hubVendor, rel);
      if (!check.ok) { send(400, { error: check.reason }); return; }
      if (rec.meta instanceof Error) { send(400, { error: rec.meta.message }); return; }
      const key = `${vendor}/${rel}`;
      const reset = rec.meta.reset === true;
      if (reset) {
        if (offset !== 0) { send(400, { error: 'reset requires offset=0' }); return; }
        files.delete(key);
      }
      const current = files.get(key) ?? Buffer.alloc(0);
      if (offset !== current.byteLength) { send(409, { size: current.byteLength }); return; }
      const next = Buffer.concat([current, bytes]);
      files.set(key, next);
      send(200, { size: next.byteLength });
      return;
    }

    if (url.pathname === '/v1/query' && req.method === 'POST') {
      rec.json = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
      const q = opts.query ?? {};
      send(
        200,
        { stdout: q.stdout ?? '', stderr: q.stderr ?? '', exit: q.exit ?? 0 },
        q.stale ? { [HEADER_STALE]: '1' } : {},
      );
      return;
    }

    send(404, { error: 'not found' });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    host,
    requests,
    files,
    options: opts,
    seed(vendor, rel, body) {
      files.set(`${vendor}/${rel}`, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8'));
    },
    by(p) { return requests.filter((r) => r.path === p); },
    close() { return new Promise<void>((resolve) => server.close(() => resolve())); },
    server,
  };
}
