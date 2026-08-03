import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ProxyServer } from '../../src/server/proxy.js';
import { CertificateAuthority } from '../../src/server/ssl.js';
import { Database } from '../../src/storage/db.js';
import { EventManager } from '../../src/server/events.js';
import { Throttler } from '../../src/server/throttle.js';
import { DEFAULT_CONFIG } from '../../src/shared/types.js';
import type { Config, RequestRecord } from '../../src/shared/types.js';
import { watchProcessErrors } from '../helpers/process-errors.js';

/**
 * The client-facing half of HTTP/2 support, driven by a real `node:http2` client
 * through a real CONNECT tunnel on ephemeral ports.
 *
 * Nothing here is mocked, because nothing here exists off the wire: ALPN
 * selection, `RST_STREAM`, extended CONNECT and stream multiplexing are all
 * protocol behaviours. The client always reaches the proxy the way a browser
 * does — `CONNECT host:port`, then TLS, then whatever ALPN settled on.
 */

let tmpDir: string;
let ca: CertificateAuthority;
let caPem: string;
let tlsCert: { cert: string; key: string };

beforeAll(() => {
  tmpDir = path.join(os.tmpdir(), `laurel-h2-client-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  ca = new CertificateAuthority(path.join(tmpDir, 'ca'));
  ca.init();
  caPem = fs.readFileSync(ca.getCaCertPath(), 'utf-8');
  // Generating RSA keys with forge is by far the slowest thing in this file, so
  // one certificate serves every origin below. Hostname is always `localhost`.
  tlsCert = ca.getCertForHost('localhost');
}, 60_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- origins ---------------------------------------------------------------

/**
 * Server-side h2 sessions, so shutdown can destroy them.
 *
 * `Http2Server.close()` only calls back once every session has ended, and
 * `closeAllConnections()` does not end them — so closing an h2 origin while the
 * proxy still holds a pooled session to it hangs forever.
 */
const serverSessions = new WeakMap<object, Set<http2.ServerHttp2Session>>();

function trackSessions<T extends http2.Http2SecureServer>(server: T): T {
  const sessions = new Set<http2.ServerHttp2Session>();
  serverSessions.set(server, sessions);
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.on('close', () => sessions.delete(session));
  });
  return server;
}

type AnyServer = http.Server | https.Server | http2.Http2SecureServer;

function listen(server: AnyServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closeServer(server: AnyServer): Promise<void> {
  return new Promise((resolve) => {
    for (const session of serverSessions.get(server) ?? []) session.destroy();
    server.close(() => resolve());
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

/** An origin that speaks h2 and nothing else, so ALPN upstream must land on h2. */
function h2Origin(
  handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
): Promise<{ server: http2.Http2SecureServer; port: number }> {
  const server = trackSessions(
    http2.createSecureServer({ key: tlsCert.key, cert: tlsCert.cert, allowHTTP1: false }),
  );
  server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    // An h2 stream whose peer resets it emits 'error'; unhandled, that is an
    // uncaught exception in the test process.
    stream.on('error', () => {});
    handler(stream, headers);
  });
  return listen(server).then((port) => ({ server, port }));
}

/**
 * An origin that speaks HTTP/1.1 and nothing else — no ALPN protocols are
 * configured, so it never selects h2. This is the independent-hops case: the
 * client can be on h2 while this hop is not.
 */
function h1Origin(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: https.Server; port: number }> {
  const server = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, handler);
  server.on('clientError', () => {});
  return listen(server).then((port) => ({ server, port }));
}

// ---- client through the proxy ----------------------------------------------

/** `CONNECT host:port` through the proxy, resolving to the raw tunnel socket. */
function connectTunnel(proxyPort: number, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
    });
    req.on('connect', (_res, socket) => resolve(socket as net.Socket));
    req.on('error', reject);
    req.end();
  });
}

/**
 * TLS over the tunnel, offering whatever ALPN the caller asks for.
 *
 * `alpn: undefined` means the ClientHello carries no ALPN extension at all,
 * which is the case a proxy must not treat as h2.
 */
async function tunnelTls(
  proxyPort: number,
  host: string,
  port: number,
  alpn?: string[],
): Promise<tls.TLSSocket> {
  const tunnel = await connectTunnel(proxyPort, host, port);
  const socket = tls.connect({
    socket: tunnel,
    host,
    servername: host,
    ca: caPem,
    ...(alpn ? { ALPNProtocols: alpn } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** An h2 session whose transport is a CONNECT tunnel through the proxy. */
async function h2Through(
  proxyPort: number,
  host: string,
  port: number,
): Promise<http2.ClientHttp2Session> {
  const tunnel = await connectTunnel(proxyPort, host, port);
  const session = http2.connect(`https://${host}:${port}`, {
    createConnection: () =>
      tls.connect({
        socket: tunnel,
        host,
        servername: host,
        ca: caPem,
        ALPNProtocols: ['h2', 'http/1.1'],
      }),
  });
  await new Promise<void>((resolve, reject) => {
    session.once('connect', () => resolve());
    session.once('error', reject);
  });
  return session;
}

interface H2Result {
  status: number;
  headers: http2.IncomingHttpHeaders;
  body: string;
}

function h2Request(
  session: http2.ClientHttp2Session,
  headers: http2.OutgoingHttpHeaders,
  body?: string,
): Promise<H2Result> {
  return new Promise((resolve, reject) => {
    const stream = session.request(headers);
    const chunks: Buffer[] = [];
    let resHeaders: http2.IncomingHttpHeaders = {};
    stream.on('response', (h) => { resHeaders = h; });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () =>
      resolve({
        status: Number(resHeaders[':status']),
        headers: resHeaders,
        body: Buffer.concat(chunks).toString(),
      }),
    );
    if (body === undefined) stream.end();
    else stream.end(body);
  });
}

/** One HTTP/1.1 request over an already-established tunnel socket. */
function h1Request(
  socket: tls.TLSSocket,
  host: string,
  urlPath: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        createConnection: () => socket as unknown as net.Socket,
        host,
        path: urlPath,
        headers: { Host: host },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Give the proxy's 100ms batch write timer room to flush. */
const flushWrites = (): Promise<void> => sleep(400);

/**
 * Resolves to `'HUNG'` if `work` has not settled in time.
 *
 * "Fails cleanly" is a claim about *settling*, and a bare `await` cannot tell a
 * hang from a slow pass — the test would fail on the runner's own timeout with no
 * indication of which property broke. Racing a sentinel makes it an assertion.
 */
function orHang<T>(work: Promise<T>, ms = 4000): Promise<T | 'HUNG'> {
  return Promise.race([work, sleep(ms).then(() => 'HUNG' as const)]);
}

// ---- fixture ---------------------------------------------------------------

interface Fixture {
  proxy: ProxyServer;
  db: Database;
  events: EventManager;
  proxyPort: number;
  dbPath: string;
  caDir: string;
  rows(recordedPath: string): RequestRecord[];
}

async function startProxy(overrides: Partial<Config> = {}): Promise<Fixture> {
  const dbPath = path.join(tmpDir, `h2-${randomUUID()}.db`);
  const db = new Database(dbPath);
  const events = new EventManager();
  const config: Config = { ...DEFAULT_CONFIG, proxyPort: 0, uiPort: 0, dbPath, ...overrides };
  const proxy = new ProxyServer(db, ca, events, config);
  const proxyPort = await proxy.start();
  return {
    proxy,
    db,
    events,
    proxyPort,
    dbPath,
    caDir: path.join(tmpDir, 'ca'),
    rows: (recordedPath) => db.query({ limit: 500 }).data.filter((r) => r.path === recordedPath),
  };
}

async function stopProxy(fixture: Fixture): Promise<void> {
  await fixture.proxy.stop();
  fixture.events.stop();
  fixture.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(fixture.dbPath + suffix); } catch { /* nothing to remove */ }
  }
}

// ---- tests -----------------------------------------------------------------

describe('http2 client hop', () => {
  let fixture: Fixture;

  beforeAll(async () => { fixture = await startProxy(); }, 30_000);
  afterAll(async () => { await stopProxy(fixture); });

  it('negotiates h2 with a client and relays a body intact in both directions', async () => {
    const payload = 'x'.repeat(50_000);
    const origin = await h2Origin((stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const received = Buffer.concat(chunks).toString();
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end(`method=${headers[':method']} echoed=${received.length} ${received === payload}`);
      });
    });

    try {
      const session = await h2Through(fixture.proxyPort, 'localhost', origin.port);
      try {
        // The client only got here by picking `h2` from the proxy's ALPN offer.
        expect(session.alpnProtocol).toBe('h2');
        const res = await h2Request(
          session,
          { ':method': 'POST', ':path': '/h2-echo', 'content-type': 'text/plain' },
          payload,
        );
        expect(res.status).toBe(200);
        // Byte counts and an equality check, so a body that was silently
        // re-chunked, truncated or re-encoded cannot pass.
        expect(res.body).toBe(`method=POST echoed=${payload.length} true`);
      } finally {
        session.destroy();
      }

      await flushWrites();

      const rows = fixture.rows('/h2-echo');
      expect(rows).toHaveLength(1);
      expect(rows[0].method).toBe('POST');
      expect(rows[0].status).toBe(200);
      expect(rows[0].url).toBe(`https://localhost:${origin.port}/h2-echo`);
      expect(rows[0].request_size).toBe(payload.length);
      expect(Buffer.from(rows[0].request_body!).toString()).toBe(payload);
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);

  it('serves an h2 client from an HTTP/1.1-only origin', async () => {
    const origin = await h1Origin((req, res) => {
      // Headers HTTP/2 forbids outright. `writeHead` on an `Http2ServerResponse`
      // does not ignore them, it throws ERR_HTTP2_INVALID_CONNECTION_HEADERS out
      // of an exchange nobody awaits — so relaying these verbatim would be a
      // process exit, not a bad header.
      res.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
      });
      res.end(`h1-origin saw ${req.httpVersion} at ${req.url}`);
    });

    try {
      const session = await h2Through(fixture.proxyPort, 'localhost', origin.port);
      try {
        expect(session.alpnProtocol).toBe('h2');
        const res = await h2Request(session, { ':method': 'GET', ':path': '/mixed-hops' });
        expect(res.status).toBe(200);
        // The two hops really are different protocols: h2 in front, 1.1 behind.
        expect(res.body).toBe('h1-origin saw 1.1 at /mixed-hops');
        expect(res.headers['content-type']).toBe('text/plain');
        expect(res.headers.connection).toBeUndefined();
        expect(res.headers['keep-alive']).toBeUndefined();
      } finally {
        session.destroy();
      }

      await flushWrites();

      const rows = fixture.rows('/mixed-hops');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(200);
      // The recording keeps what the origin actually said, connection headers
      // and all — stripping is a relay concern, not a capture one.
      expect(JSON.parse(rows[0].response_headers!).connection).toBe('keep-alive');
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);

  it('puts a client that offers no ALPN at all on HTTP/1.1', async () => {
    const origin = await h1Origin((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`no-alpn ${req.url}`);
    });

    try {
      const socket = await tunnelTls(fixture.proxyPort, 'localhost', origin.port);
      try {
        // `false`, not a string and not `undefined`: this is the value the proxy
        // must not confuse with `'h2'`.
        expect(socket.alpnProtocol).toBe(false);
        const res = await orHang(h1Request(socket, 'localhost', '/no-alpn'));
        expect(res).not.toBe('HUNG');
        expect((res as { status: number; body: string }).status).toBe(200);
        expect((res as { status: number; body: string }).body).toBe('no-alpn /no-alpn');
      } finally {
        socket.destroy();
      }

      await flushWrites();
      expect(fixture.rows('/no-alpn')).toHaveLength(1);
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);

  it('keeps an HTTP/1.1 client on HTTP/1.1 when it asks for it by name', async () => {
    const origin = await h1Origin((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`h1 ${req.url}`);
    });

    try {
      const socket = await tunnelTls(fixture.proxyPort, 'localhost', origin.port, ['http/1.1']);
      try {
        expect(socket.alpnProtocol).toBe('http/1.1');
        const res = await orHang(h1Request(socket, 'localhost', '/alpn-h1'));
        expect(res).not.toBe('HUNG');
        expect((res as { body: string }).body).toBe('h1 /alpn-h1');
      } finally {
        socket.destroy();
      }

      await flushWrites();
      expect(fixture.rows('/alpn-h1')).toHaveLength(1);
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);

  it('fails an h2 client cleanly when it reaches for WebSockets', async () => {
    const origin = await h1Origin((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    try {
      const session = await h2Through(fixture.proxyPort, 'localhost', origin.port);
      try {
        // RFC 8441 extended CONNECT. Out of scope, and out of scope has to mean
        // *rejected*: the server never advertises SETTINGS_ENABLE_CONNECT_PROTOCOL,
        // so the stream is reset rather than left open.
        const extended = await orHang(
          new Promise<string>((resolve) => {
            const stream = session.request({
              ':method': 'CONNECT',
              ':protocol': 'websocket',
              ':scheme': 'https',
              ':path': '/ws',
              ':authority': 'localhost',
            });
            stream.on('error', (err: NodeJS.ErrnoException) => resolve(`error:${err.code}`));
            stream.on('response', (h) => resolve(`response:${h[':status']}`));
          }),
        );
        expect(extended).not.toBe('HUNG');
        expect(extended).toBe('error:ERR_HTTP2_STREAM_ERROR');

        // A plain CONNECT stream is answered rather than reset, because the
        // compatibility layer has no `connect` listener to hand it to. Either way
        // the client learns immediately.
        const plain = await orHang(
          new Promise<string>((resolve) => {
            const stream = session.request({ ':method': 'CONNECT', ':authority': 'localhost:1' });
            stream.on('error', (err: NodeJS.ErrnoException) => resolve(`error:${err.code}`));
            stream.on('response', (h) => resolve(`response:${h[':status']}`));
          }),
        );
        expect(plain).not.toBe('HUNG');
        expect(plain).toBe('response:405');

        // HTTP/2's third route to a WebSocket is the HTTP/1.1 one, and the
        // protocol forbids the header outright — the client's own request builder
        // refuses before a byte leaves.
        expect(() =>
          session.request({ ':method': 'GET', ':path': '/ws', upgrade: 'websocket' }),
        ).toThrow(/Connection specific headers are forbidden/);

        // The session survived all three: one refused stream is not a dead tunnel.
        const after = await h2Request(session, { ':method': 'GET', ':path': '/after-ws' });
        expect(after.status).toBe(200);
      } finally {
        session.destroy();
      }

      await flushWrites();
      // None of the three refusals is an exchange, so none of them is recorded.
      expect(fixture.rows('/ws')).toHaveLength(0);
      expect(fixture.rows('/after-ws')).toHaveLength(1);
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);
});

describe('http2 client hop — streams that die', () => {
  let fixture: Fixture;

  beforeAll(async () => { fixture = await startProxy(); }, 30_000);
  afterAll(async () => { await stopProxy(fixture); });

  it('does not record an exchange whose client reset the stream mid-request', async () => {
    // Sends part of a body, then cancels. An h2 `RST_STREAM` is not an error the
    // way a dead TCP socket is: Node's compatibility layer pushes `null` into the
    // request, so a half-received body can reach a `for await` looking exactly
    // like a complete one.
    //
    // The origin answers 204 — no body at all — on purpose. A response with a
    // body would make this test pass for an uninteresting reason: writing it to
    // the reset stream throws, the relay's own `catch` notices, and none of the
    // h2-specific reasoning would be exercised. With nothing to write, every
    // signal except the ones added for h2 says the exchange succeeded.
    //
    // Measured while writing this: without a declared `content-length` the body
    // iteration does **not** throw on the reset — the compatibility layer's
    // `push(null)` gets there first — so `readBody`'s `catch` is not what saves
    // this case. The recording guard is.
    const origin = await h1Origin((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    try {
      const escaped = await watchProcessErrors(async () => {
        const session = await h2Through(fixture.proxyPort, 'localhost', origin.port);
        try {
          const stream = session.request({ ':method': 'POST', ':path': '/reset-mid-request' });
          stream.on('error', () => {});
          stream.write('partial');
          await sleep(120);
          stream.close(http2.constants.NGHTTP2_CANCEL);
          await sleep(200);

          // One reset stream must not cost the connection: the session is still
          // usable, which is the whole point of multiplexing.
          const after = await orHang(h2Request(session, { ':method': 'GET', ':path': '/after-reset' }));
          expect(after).not.toBe('HUNG');
          expect((after as H2Result).status).toBe(204);
        } finally {
          session.destroy();
        }
        await flushWrites();
      });

      // A recording failure may lose a row; it may never end the process.
      expect(escaped).toEqual([]);
      // The property: a partial request is not a completed exchange. Recording it
      // with a 204 would be a lie about the one thing this proxy exists to show.
      expect(fixture.rows('/reset-mid-request')).toHaveLength(0);
      expect(fixture.rows('/after-reset')).toHaveLength(1);
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);

  it('does not record an exchange whose client walked away before the response', async () => {
    // The nastier shape, and the one no `catch` around the body read can see: the
    // request body arrives *complete*, so iteration ends cleanly, and only then
    // does the client cancel. The origin is slow and answers with no body at all,
    // which is exactly the combination that makes every other signal say
    // "success" — `Http2ServerResponse.writeHead` and `end` are both silent
    // no-ops on a closed stream, so nothing throws and the upstream response
    // genuinely was complete.
    const origin = await h1Origin((_req, res) => {
      setTimeout(() => {
        res.writeHead(204);
        res.end();
      }, 500);
    });

    try {
      const escaped = await watchProcessErrors(async () => {
        const session = await h2Through(fixture.proxyPort, 'localhost', origin.port);
        try {
          const stream = session.request({ ':method': 'POST', ':path': '/abandoned' });
          stream.on('error', () => {});
          stream.end('complete-body');
          await sleep(120);
          stream.close(http2.constants.NGHTTP2_CANCEL);
          // Past the origin's delay, so a request that was forwarded anyway has
          // had every chance to come back and be recorded.
          await sleep(700);
        } finally {
          session.destroy();
        }
        await flushWrites();
      });

      expect(escaped).toEqual([]);
      expect(fixture.rows('/abandoned')).toHaveLength(0);
    } finally {
      await closeServer(origin.server);
    }
  }, 30_000);
});

describe('http2 client hop — throttling', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startProxy();
    // 200 kbps = 25 000 B/s down, no upload limit, no added latency. One link.
    fixture.proxy.setThrottler(
      new Throttler({ enabled: true, downKbps: 200, upKbps: 0, latencyMs: 0 }),
    );
  }, 30_000);
  afterAll(async () => { await stopProxy(fixture); });

  it('makes h2 streams multiplexed on one connection contend for the same link', async () => {
    const size = 20_000;
    const origin = await h1Origin((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(size, 0x61));
    });

    try {
      const session = await h2Through(fixture.proxyPort, 'localhost', origin.port);
      try {
        const startedAt = Date.now();
        const [first, second] = await Promise.all([
          h2Request(session, { ':method': 'GET', ':path': '/throttled-a' }),
          h2Request(session, { ':method': 'GET', ':path': '/throttled-b' }),
        ]);
        const elapsed = Date.now() - startedAt;

        expect(first.body.length).toBe(size);
        expect(second.body.length).toBe(size);

        // 40 000 bytes over one 25 000 B/s link is ~1.6s. Per-stream limiters
        // would let both finish in ~0.8s, so anything under ~1.3s means the
        // streams were not sharing the link. The upper bound keeps this a
        // statement about contention rather than an open-ended wait.
        expect(elapsed).toBeGreaterThan(1_300);
        expect(elapsed).toBeLessThan(8_000);
      } finally {
        session.destroy();
      }

      await flushWrites();
      expect(fixture.rows('/throttled-a')).toHaveLength(1);
      expect(fixture.rows('/throttled-b')).toHaveLength(1);
    } finally {
      await closeServer(origin.server);
    }
  }, 40_000);
});
