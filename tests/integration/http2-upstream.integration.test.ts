import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CertificateAuthority } from '../../src/server/ssl.js';
import { UpstreamTransport } from '../../src/server/upstream.js';
import type { UpstreamRequestInit, UpstreamResponse } from '../../src/server/upstream.js';
import { watchProcessErrors } from '../helpers/process-errors.js';

/**
 * Every test here runs against a real `node:http2` (or `node:https`, or
 * `node:http`) server on an ephemeral port. Nothing is mocked: the properties
 * under test — ALPN, flow control, RST_STREAM, GOAWAY — only exist on the wire.
 */

let tmpDir: string;
let tlsCert: { cert: string; key: string };

beforeAll(() => {
  tmpDir = path.join(os.tmpdir(), `laurel-upstream-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const ca = new CertificateAuthority(path.join(tmpDir, 'ca'));
  ca.init();
  // One certificate for every TLS server below: generating RSA keys with forge
  // is the slowest thing in this file, and `rejectUnauthorized: false` on the
  // client side means the subject never matters.
  tlsCert = ca.getCertForHost('localhost');
}, 60_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------------

function listen(server: http.Server | https.Server | http2.Http2Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    // A bind failure must reject rather than leave the caller waiting: several
    // tests below deliberately re-bind a port they have just released.
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

/**
 * Server-side HTTP/2 sessions, so they can be destroyed on shutdown.
 *
 * `Http2Server.close()` only calls back once every session has ended, and
 * `closeAllConnections()` does not end them — so closing an h2 server while a
 * client still holds a pooled session hangs forever. Several tests below keep a
 * session open on purpose.
 */
const serverSessions = new WeakMap<object, Set<http2.ServerHttp2Session>>();

function trackSessions<T extends http2.Http2Server | http2.Http2SecureServer>(server: T): T {
  const sessions = new Set<http2.ServerHttp2Session>();
  serverSessions.set(server, sessions);
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.on('close', () => sessions.delete(session));
  });
  return server;
}

function closeServer(server: http.Server | https.Server | http2.Http2Server): Promise<void> {
  return new Promise((resolve) => {
    for (const session of serverSessions.get(server) ?? []) session.destroy();
    server.close(() => resolve());
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

function h2Server(handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void) {
  const server = trackSessions(http2.createSecureServer({ key: tlsCert.key, cert: tlsCert.cert }));
  server.on('stream', (stream, headers) => {
    // Deliberate resets in these tests would otherwise surface as unhandled
    // 'error' events and kill the test process.
    stream.on('error', () => {});
    handler(stream as http2.ServerHttp2Stream, headers);
  });
  server.on('sessionError', () => {});
  server.on('clientError', () => {});
  return server;
}

function get(port: number, reqPath = '/', extra: Partial<UpstreamRequestInit> = {}): UpstreamRequestInit {
  return {
    target: { hostname: '127.0.0.1', port, protocol: 'https', path: reqPath },
    method: 'GET',
    headers: { host: '127.0.0.1' },
    body: Buffer.alloc(0),
    ...extra,
  };
}

/** Drains a response body, reporting what arrived *and* how it stopped. */
async function drain(res: UpstreamResponse): Promise<{ text: string; bytes: number; error: string | null }> {
  const chunks: Buffer[] = [];
  let error: string | null = null;
  try {
    for await (const chunk of res.body as AsyncIterable<Buffer>) chunks.push(chunk);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const body = Buffer.concat(chunks);
  return { text: body.toString('utf8'), bytes: body.length, error };
}

/** `bodyStatus()` can settle a tick after the body stream stops. */
async function settledStatus(res: UpstreamResponse) {
  for (let i = 0; i < 50; i++) {
    const status = res.bodyStatus();
    if (status.state !== 'pending') return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  return res.bodyStatus();
}

// ---- happy paths -----------------------------------------------------------

describe('upstream h2 happy path', () => {
  let server: http2.Http2SecureServer;
  let port: number;
  let transport: UpstreamTransport;
  const seen: http2.IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = h2Server((stream, headers) => {
      seen.push(headers);
      if (headers[':path'] === '/echo-body') {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          const body = Buffer.concat(chunks);
          stream.respond({ ':status': 200, 'content-length': String(body.length) });
          stream.end(body);
        });
        return;
      }
      if (headers[':path'] === '/trailers') {
        stream.respond({ ':status': 200, 'x-real': 'header' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => {
          stream.sendTrailers({ 'x-real': 'trailer-wins-if-merged', 'x-trailer-only': 'yes' });
        });
        stream.end('trailing');
        return;
      }
      if (headers[':path'] === '/head') {
        // A HEAD-shaped reply: a content-length with no body at all.
        stream.respond({ ':status': 200, 'content-length': '4096' });
        stream.end();
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'text/plain', 'x-echo': 'v' });
      stream.end('hello-h2');
    });
    port = await listen(server);
    transport = new UpstreamTransport();
  });

  afterAll(async () => {
    transport.close();
    await closeServer(server);
  });

  it('negotiates h2, returns the response and reports a complete body', async () => {
    const res = await transport.request(get(port, '/plain'));
    expect(res.protocol).toBe('h2');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['x-echo']).toBe('v');
    // The recording layer must never see an HTTP/2 pseudo-header.
    expect(Object.keys(res.headers).some((k) => k.startsWith(':'))).toBe(false);

    const body = await drain(res);
    expect(body.text).toBe('hello-h2');
    expect(body.error).toBeNull();
    expect(await settledStatus(res)).toEqual({ state: 'complete' });
  });

  it('sends only h2-legal headers, with Host folded into :authority', async () => {
    seen.length = 0;
    const res = await transport.request(
      get(port, '/plain', {
        headers: {
          host: 'origin.example',
          Connection: 'keep-alive',
          'Transfer-Encoding': 'chunked',
          'Keep-Alive': 'timeout=5',
          'Proxy-Connection': 'keep-alive',
          Upgrade: 'websocket',
          'X-Mixed-Case': 'kept',
        },
      }),
    );
    await drain(res);

    const headers = seen.at(-1)!;
    expect(headers[':authority']).toBe('origin.example');
    expect(headers[':method']).toBe('GET');
    expect(headers[':scheme']).toBe('https');
    expect(headers['x-mixed-case']).toBe('kept');
    for (const forbidden of ['connection', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade', 'host']) {
      expect(headers[forbidden]).toBeUndefined();
    }
  });

  it('uploads a request body and reads the echo back', async () => {
    const payload = Buffer.from('x'.repeat(50_000));
    const res = await transport.request(
      get(port, '/echo-body', { method: 'POST', body: payload, headers: { host: '127.0.0.1', 'content-type': 'application/octet-stream' } }),
    );
    const body = await drain(res);
    expect(body.bytes).toBe(payload.length);
    expect(body.error).toBeNull();
    expect(await settledStatus(res)).toEqual({ state: 'complete' });
  });

  it('surfaces trailers separately instead of merging them into headers', async () => {
    const res = await transport.request(get(port, '/trailers'));
    const body = await drain(res);
    expect(body.text).toBe('trailing');
    await settledStatus(res);
    expect(res.headers['x-real']).toBe('header');
    expect(res.trailers()['x-real']).toBe('trailer-wins-if-merged');
    expect(res.trailers()['x-trailer-only']).toBe('yes');
    expect(res.headers['x-trailer-only']).toBeUndefined();
  });

  it('does not call a bodyless response truncated for its content-length', async () => {
    const res = await transport.request(get(port, '/head', { method: 'HEAD' }));
    const body = await drain(res);
    expect(body.bytes).toBe(0);
    expect(body.error).toBeNull();
    expect(await settledStatus(res)).toEqual({ state: 'complete' });
  });

  it('reuses one pooled session across requests', async () => {
    const sessions = new Set<http2.ServerHttp2Session>();
    const track = (stream: http2.ServerHttp2Stream) => sessions.add(stream.session as http2.ServerHttp2Session);
    server.on('stream', track);
    try {
      await drain(await transport.request(get(port, '/plain')));
      await drain(await transport.request(get(port, '/plain')));
      await drain(await transport.request(get(port, '/plain')));
      expect(sessions.size).toBe(1);
      expect(transport.stats().sessions).toBe(1);
      // One ALPN probe, cached: the origin is not re-probed per request.
      expect(transport.stats().alpnEntries).toBe(1);
    } finally {
      server.off('stream', track);
    }
  });
});

// ---- protocol selection ----------------------------------------------------

describe('upstream protocol selection', () => {
  it('falls back to HTTP/1.1 when the origin does not offer h2', async () => {
    const server = https.createServer(
      { key: tlsCert.key, cert: tlsCert.cert, ALPNProtocols: ['http/1.1'] },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello-h1');
      },
    );
    const port = await listen(server);
    const transport = new UpstreamTransport();
    try {
      const res = await transport.request(get(port, '/plain'));
      expect(res.protocol).toBe('http/1.1');
      expect(res.status).toBe(200);
      const body = await drain(res);
      expect(body.text).toBe('hello-h1');
      expect(body.error).toBeNull();
      expect(await settledStatus(res)).toEqual({ state: 'complete' });
      // No h2 session was opened for an origin that cannot speak it.
      expect(transport.stats().sessions).toBe(0);
    } finally {
      transport.close();
      await closeServer(server);
    }
  });

  it('never probes ALPN for a cleartext target', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('cleartext');
    });
    const port = await listen(server);
    const transport = new UpstreamTransport();
    try {
      const res = await transport.request({
        target: { hostname: '127.0.0.1', port, protocol: 'http', path: '/' },
        method: 'GET',
        headers: { host: '127.0.0.1' },
        body: Buffer.alloc(0),
      });
      expect(res.protocol).toBe('http/1.1');
      expect((await drain(res)).text).toBe('cleartext');
      expect(transport.stats()).toEqual({ alpnEntries: 0, sessions: 0 });
    } finally {
      transport.close();
      await closeServer(server);
    }
  });

  it('caches the ALPN verdict, and lets a negative one expire', async () => {
    // `Connection: close` keeps Node's https agent from pooling a keep-alive
    // socket to a server this test is about to replace. Reusing one produces an
    // ECONNRESET that (occasionally, depending on when the RST lands relative to
    // the agent's own listeners) escapes as an uncaught exception — a real Node
    // hazard on the pre-existing HTTP/1.1 path, but not the property under test.
    const h1 = https.createServer(
      { key: tlsCert.key, cert: tlsCert.cert, ALPNProtocols: ['http/1.1'] },
      (_req, res) => res.writeHead(200, { connection: 'close' }).end('h1'),
    );
    const port = await listen(h1);
    // Long enough that the cache hit below is decided by the cache, short enough
    // that the test does not have to wait around for expiry.
    const transport = new UpstreamTransport({ h1TtlMs: 300 });
    try {
      expect((await transport.request(get(port))).protocol).toBe('http/1.1');
      expect(transport.stats().alpnEntries).toBe(1);
      await closeServer(h1);

      // Same port, now an origin that offers h2 as well. While the negative
      // entry is live the cached verdict is reused without re-probing...
      // One compatibility-API handler for both protocols: adding a 'stream'
      // listener as well would answer h2 requests twice.
      const h2 = trackSessions(http2.createSecureServer(
        { key: tlsCert.key, cert: tlsCert.cert, allowHTTP1: true },
        (req, res) => {
          const overH2 = req.httpVersion.startsWith('2');
          // `connection` is illegal in an h2 response, so only the HTTP/1.1 half
          // gets it — and only that half needs it.
          res.writeHead(200, overH2 ? {} : { connection: 'close' });
          res.end(overH2 ? 'over-h2' : 'over-h1');
        },
      ));
      h2.on('sessionError', () => {});
      await listen(h2, port);
      try {
        const cached = await transport.request(get(port));

        expect(cached.protocol).toBe('http/1.1');
        expect((await drain(cached)).text).toBe('over-h1');

        // ...and once it expires the origin is re-probed and h2 is picked up, so
        // a stale negative cannot pin an origin to HTTP/1.1 forever.
        await new Promise((r) => setTimeout(r, 350));
        const fresh = await transport.request(get(port));
        expect(fresh.protocol).toBe('h2');
        expect((await drain(fresh)).text).toBe('over-h2');
      } finally {
        await closeServer(h2);
      }
    } finally {
      transport.close();
    }
  }, 20_000);

  it('recovers when a cached h2 verdict has gone stale', async () => {
    const h2 = h2Server((stream) => {
      stream.respond({ ':status': 200 });
      stream.end('h2');
    });
    const port = await listen(h2);
    const transport = new UpstreamTransport();
    try {
      expect((await transport.request(get(port))).protocol).toBe('h2');
      expect(transport.stats().alpnEntries).toBe(1);
      await closeServer(h2);

      // Same port, now HTTP/1.1-only, with the h2 verdict still cached. Node's
      // `http2.connect` offers only `h2`, so this handshake fails with a TLS
      // no-application-protocol alert rather than negotiating something else —
      // which must become a fallback, not a failed request.
      const h1 = https.createServer(
        { key: tlsCert.key, cert: tlsCert.cert, ALPNProtocols: ['http/1.1'] },
        (_req, res) => res.writeHead(200, { connection: 'close' }).end('h1-now'),
      );
      await listen(h1, port);
      try {
        const res = await transport.request(get(port));
        expect(res.protocol).toBe('http/1.1');
        expect((await drain(res)).text).toBe('h1-now');
        expect(await settledStatus(res)).toEqual({ state: 'complete' });
      } finally {
        await closeServer(h1);
      }
    } finally {
      transport.close();
    }
  }, 20_000);

  it('does not cache a verdict when the probe itself fails', async () => {
    // A port with nothing on it: the probe fails, and that is evidence about
    // reachability, not about protocols. Caching it would pin the origin to
    // HTTP/1.1 for a TTL over one bad moment.
    const idle = http.createServer();
    const port = await listen(idle);
    await closeServer(idle);

    const transport = new UpstreamTransport();
    try {
      await expect(transport.request(get(port))).rejects.toThrow();
      expect(transport.stats().alpnEntries).toBe(0);
    } finally {
      transport.close();
    }
  });

  it('bounds the pooled sessions and releases them on close', async () => {
    const servers = await Promise.all(
      [0, 0].map(async () => {
        const s = h2Server((stream) => {
          stream.respond({ ':status': 200 });
          stream.end('h2');
        });
        return { server: s, port: await listen(s) };
      }),
    );
    const transport = new UpstreamTransport({ maxSessions: 1 });
    try {
      for (const { port } of servers) {
        expect((await transport.request(get(port))).protocol).toBe('h2');
        expect(transport.stats().sessions).toBeLessThanOrEqual(1);
      }
      expect(transport.stats().sessions).toBe(1);
      transport.close();
      expect(transport.stats().sessions).toBe(0);
    } finally {
      transport.close();
      await Promise.all(servers.map(({ server }) => closeServer(server)));
    }
  }, 20_000);

  it('bounds the ALPN cache', async () => {
    const servers = await Promise.all(
      [0, 0, 0].map(async () => {
        const s = https.createServer(
          { key: tlsCert.key, cert: tlsCert.cert, ALPNProtocols: ['http/1.1'] },
          (_req, res) => res.end('h1'),
        );
        return { server: s, port: await listen(s) };
      }),
    );
    const transport = new UpstreamTransport({ maxAlpnEntries: 2 });
    try {
      for (const { port } of servers) {
        await drain(await transport.request(get(port)));
        expect(transport.stats().alpnEntries).toBeLessThanOrEqual(2);
      }
      expect(transport.stats().alpnEntries).toBe(2);
    } finally {
      transport.close();
      await Promise.all(servers.map(({ server }) => closeServer(server)));
    }
  }, 20_000);
});

// ---- truncation ------------------------------------------------------------

describe('upstream h2 truncation is never reported as success', () => {
  let server: http2.Http2SecureServer;
  let port: number;
  let transport: UpstreamTransport;

  beforeAll(async () => {
    server = h2Server((stream, headers) => {
      switch (headers[':path']) {
        case '/reset-internal':
          stream.respond({ ':status': 200 });
          stream.write('partial');
          // `destroy(err)` sends RST_STREAM with no END_STREAM before it — the
          // shape a client sees when an origin gives up mid-response. Node's
          // `stream.close(code)` is *not* that: it ends the writable side first,
          // so the peer receives a complete message followed by a reset.
          setTimeout(() => stream.destroy(new Error('origin gave up')), 20);
          return;
        case '/reset-declared-length':
          stream.respond({ ':status': 200, 'content-length': '1000' });
          stream.write('partial');
          setTimeout(() => stream.destroy(new Error('origin gave up')), 20);
          return;
        case '/short-of-declared-length':
          // Ends cleanly, but short of what it promised.
          stream.respond({ ':status': 200, 'content-length': '1000' });
          stream.end('only-this');
          return;
        case '/kill-session':
          stream.respond({ ':status': 200 });
          stream.write('partial');
          setTimeout(() => stream.session!.destroy(), 20);
          return;
        case '/reset-after-headers-only':
          stream.respond({ ':status': 200 });
          setTimeout(() => stream.destroy(new Error('nothing for you')), 20);
          return;
        default:
          stream.respond({ ':status': 200 });
          stream.end('ok');
      }
    });
    port = await listen(server);
    transport = new UpstreamTransport();
  });

  afterAll(async () => {
    transport.close();
    await closeServer(server);
  });

  it('errors the body and reports truncated on a mid-response RST_STREAM', async () => {
    const res = await transport.request(get(port, '/reset-internal'));
    expect(res.status).toBe(200);
    const body = await drain(res);
    expect(body.text).toBe('partial');
    expect(body.error).not.toBeNull();
    const status = await settledStatus(res);
    expect(status.state).toBe('truncated');
  });

  it('reports truncated when a response is reset before any body arrives', async () => {
    const res = await transport.request(get(port, '/reset-after-headers-only'));
    const body = await drain(res);
    expect(body.bytes).toBe(0);
    expect(body.error).not.toBeNull();
    expect((await settledStatus(res)).state).toBe('truncated');
  });

  it('catches a reset that stops short of a declared content-length', async () => {
    const res = await transport.request(get(port, '/reset-declared-length'));
    const body = await drain(res);
    expect(body.bytes).toBeLessThan(1000);
    expect(body.error).not.toBeNull();
    expect((await settledStatus(res)).state).toBe('truncated');
  });

  it('catches a clean end that stops short of a declared content-length', async () => {
    const res = await transport.request(get(port, '/short-of-declared-length'));
    const body = await drain(res);
    // Either detector may fire first: Node's own content-length check, or the
    // byte count kept alongside it here. What matters is that neither lets a
    // short body through as a complete one.
    expect(body.error).toMatch(/PROTOCOL_ERROR|expected 1000 bytes, received 9/);
    expect((await settledStatus(res)).state).toBe('truncated');
  });

  it('errors the body when the session dies mid-response', async () => {
    const res = await transport.request(get(port, '/kill-session'));
    const body = await drain(res);
    expect(body.text).toBe('partial');
    expect(body.error).not.toBeNull();
    expect((await settledStatus(res)).state).toBe('truncated');
    // A session that died is not left in the pool for the next request.
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.stats().sessions).toBe(0);
  });

  it('does not end the process when the origin truncates a body nobody is reading yet', async () => {
    // The shipped window: `handleExchange` resolves the upstream response, awaits
    // `throttle.delayLatency()` and only then starts its `for await`. A real
    // origin resetting inside that window used to destroy the body stream while
    // it had no 'error' listener — one uncaught exception per exchange, and with
    // no `uncaughtException` handler in `src/`, one dead proxy. No test covered
    // deferred consumption of an h2 body at all, which is exactly where it lived.
    let res!: UpstreamResponse;
    const escaped = await watchProcessErrors(async () => {
      res = await transport.request(get(port, '/reset-internal'));
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(escaped).toEqual([]);

    // Losing the recording is the acceptable half; hiding the truncation is not.
    const body = await drain(res);
    expect(body.error).not.toBeNull();
    expect((await settledStatus(res)).state).toBe('truncated');
  });

  it('rejects rather than resolving when the stream dies before a response', async () => {
    const rude = h2Server((stream) => {
      stream.destroy(new Error('no response for you'));
    });
    const rudePort = await listen(rude);
    const t = new UpstreamTransport();
    try {
      // However it is reported, the one thing it must not be is a resolved
      // response with an empty body.
      await expect(t.request(get(rudePort, '/no-response'))).rejects.toThrow(
        /INTERNAL_ERROR|closed before a response arrived/,
      );
    } finally {
      t.close();
      await closeServer(rude);
    }
  });
});

describe('upstream HTTP/1.1 truncation detection is unchanged', () => {
  it('errors the body and reports truncated when the origin cuts a chunked response', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const port = await listen(server);
    const transport = new UpstreamTransport();
    try {
      const res = await transport.request({
        target: { hostname: '127.0.0.1', port, protocol: 'http', path: '/' },
        method: 'GET',
        headers: { host: '127.0.0.1' },
        body: Buffer.alloc(0),
      });
      const body = await drain(res);
      expect(body.text).toBe('partial');
      expect(body.error).not.toBeNull();
      expect((await settledStatus(res)).state).toBe('truncated');
    } finally {
      transport.close();
      await closeServer(server);
    }
  });
});

// ---- GOAWAY and session pooling -------------------------------------------

describe('upstream h2 GOAWAY', () => {
  it('lets an in-flight response finish and stops reusing the session', async () => {
    const server = h2Server((stream, headers) => {
      if (headers[':path'] === '/goaway-mid') {
        stream.respond({ ':status': 200, 'content-length': '12' });
        stream.write('first-');
        // Refuse new streams, then finish this one — exactly the case a caller
        // must still see as a complete response.
        stream.session!.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id);
        setTimeout(() => stream.end('second'), 100);
        return;
      }
      stream.respond({ ':status': 200 });
      stream.end('after');
    });
    const port = await listen(server);
    const transport = new UpstreamTransport();
    try {
      const res = await transport.request(get(port, '/goaway-mid'));

      // Mid-exchange: the GOAWAY has arrived but this stream has not finished.
      // The session must already be out of the pool — a concurrent request that
      // grabbed it would be refused — while this response continues.
      await new Promise((r) => setTimeout(r, 40));
      expect(transport.stats().sessions).toBe(0);

      const body = await drain(res);
      expect(body.text).toBe('first-second');
      expect(body.error).toBeNull();
      expect(await settledStatus(res)).toEqual({ state: 'complete' });

      // And the next request opens a fresh session instead of being refused.
      const next = await transport.request(get(port, '/plain'));
      expect((await drain(next)).text).toBe('after');
      expect(next.protocol).toBe('h2');
    } finally {
      transport.close();
      await closeServer(server);
    }
  }, 20_000);

  it('cancels the upstream stream when the caller abandons the body', async () => {
    let serverSawAbort = false;
    const server = h2Server((stream) => {
      stream.respond({ ':status': 200, 'content-length': '1000000' });
      stream.write(Buffer.alloc(16 * 1024, 0x41));
      stream.on('aborted', () => {
        serverSawAbort = true;
      });
      stream.on('close', () => {
        serverSawAbort = serverSawAbort || stream.rstCode !== 0;
      });
    });
    const port = await listen(server);
    const transport = new UpstreamTransport();
    try {
      const res = await transport.request(get(port, '/endless'));
      // What the exchange pipeline does when its client goes away.
      res.body.destroy();
      await new Promise((r) => setTimeout(r, 100));
      const status = res.bodyStatus();
      expect(status.state).toBe('truncated');
      // Abandoning must not be recorded as a clean exchange, and must not leave
      // the origin streaming into nothing.
      expect(serverSawAbort).toBe(true);
    } finally {
      transport.close();
      await closeServer(server);
    }
  }, 20_000);

  it('retries once on a fresh session when a pooled session has died unnoticed', async () => {
    const server = h2Server((stream) => {
      stream.respond({ ':status': 200 });
      stream.end('served');
    });
    const port = await listen(server);

    // The failure being modelled is a session that looks alive but is not: Node
    // raises ERR_HTTP2_GOAWAY_SESSION for a stream the origin has already
    // promised never to process. Poisoning `request` on the first pooled session
    // reproduces that deterministically, against a real server, without waiting
    // on a race between a GOAWAY frame and the next request.
    const created: http2.ClientHttp2Session[] = [];
    let poisoned = false;
    const transport = new UpstreamTransport({
      connect: (authority, options) => {
        const session = http2.connect(authority, options);
        created.push(session);
        return session;
      },
    });

    try {
      expect((await drain(await transport.request(get(port, '/one')))).text).toBe('served');
      expect(created.length).toBe(1);

      const pooled = created[0];
      const realRequest = pooled.request.bind(pooled);
      pooled.request = ((...args: Parameters<typeof realRequest>) => {
        if (!poisoned) {
          poisoned = true;
          const err = new Error('New stream cannot be created after receiving a goaway');
          (err as NodeJS.ErrnoException).code = 'ERR_HTTP2_GOAWAY_SESSION';
          throw err;
        }
        return realRequest(...args);
      }) as typeof pooled.request;

      const res = await transport.request(get(port, '/two'));
      expect(poisoned).toBe(true);
      expect(res.protocol).toBe('h2');
      expect((await drain(res)).text).toBe('served');
      expect(await settledStatus(res)).toEqual({ state: 'complete' });
      // The retry went to a genuinely new session, not the corpse.
      expect(created.length).toBe(2);
    } finally {
      transport.close();
      await closeServer(server);
    }
  }, 20_000);

  it('keeps a healthy session pooled when a single stream fails', async () => {
    const sessions = new Set<http2.ServerHttp2Session>();
    const server = h2Server((stream, headers) => {
      sessions.add(stream.session as http2.ServerHttp2Session);
      if (headers[':path'] === '/bad-stream') {
        // One stream reset; the connection itself is untouched.
        stream.destroy(new Error('this stream only'));
        return;
      }
      stream.respond({ ':status': 200 });
      stream.end('still-here');
    });
    const port = await listen(server);
    const transport = new UpstreamTransport();
    try {
      expect((await drain(await transport.request(get(port, '/first')))).text).toBe('still-here');
      await expect(transport.request(get(port, '/bad-stream'))).rejects.toThrow();

      // The session survived the bad stream: still pooled, and the next request
      // multiplexes onto it rather than paying for a new handshake.
      expect(transport.stats().sessions).toBe(1);
      expect((await drain(await transport.request(get(port, '/third')))).text).toBe('still-here');
      expect(sessions.size).toBe(1);
    } finally {
      transport.close();
      await closeServer(server);
    }
  }, 20_000);

  it('does not retry a failure that proves nothing about processing', async () => {
    const server = h2Server((stream) => {
      stream.respond({ ':status': 200 });
      stream.end('served');
    });
    const port = await listen(server);
    const created: http2.ClientHttp2Session[] = [];
    let poisoned = false;
    const transport = new UpstreamTransport({
      connect: (authority, options) => {
        const session = http2.connect(authority, options);
        created.push(session);
        return session;
      },
    });
    try {
      await drain(await transport.request(get(port, '/one')));
      const pooled = created[0];
      pooled.request = (() => {
        poisoned = true;
        const err = new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR');
        (err as NodeJS.ErrnoException).code = 'ERR_HTTP2_STREAM_ERROR';
        throw err;
      }) as typeof pooled.request;

      // An INTERNAL_ERROR may mean the origin already processed the request, so
      // replaying it could duplicate a side effect. The request fails instead.
      await expect(transport.request(get(port, '/two'))).rejects.toThrow(/INTERNAL_ERROR/);
      expect(poisoned).toBe(true);
      expect(created.length).toBe(1);
    } finally {
      transport.close();
      await closeServer(server);
    }
  }, 20_000);
});

// ---- flow control ----------------------------------------------------------

describe('upstream h2 flow control', () => {
  it('delivers a large body intact to a slow consumer, with backpressure engaged', async () => {
    const total = 8 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0xab);
    let sawBackpressure = false;

    const server = h2Server((stream) => {
      stream.respond({ ':status': 200, 'content-length': String(total) });
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!stream.write(chunk)) {
            // The origin was told to wait — i.e. the per-stream window closed
            // because our consumer stopped reading.
            sawBackpressure = true;
            stream.once('drain', pump);
            return;
          }
        }
        stream.end();
      };
      pump();
    });
    const port = await listen(server);
    const transport = new UpstreamTransport();

    try {
      const res = await transport.request(get(port, '/big'));
      let bytes = 0;
      let chunks = 0;
      let peakBuffered = 0;
      for await (const buf of res.body as AsyncIterable<Buffer>) {
        bytes += buf.length;
        // A consumer that stalls periodically, which is what awaiting
        // `waitForDrain` on a slow client looks like from here. The buffer is
        // sampled *after* the stall, when an unthrottled origin would have piled
        // up everything it could send.
        if (++chunks % 8 === 0) {
          await new Promise((r) => setTimeout(r, 20));
          const buffered = res.body.readableLength + (res.body as unknown as { writableLength: number }).writableLength;
          peakBuffered = Math.max(peakBuffered, buffered);
        }
      }
      expect(bytes).toBe(total);
      expect(sawBackpressure).toBe(true);
      expect(await settledStatus(res)).toEqual({ state: 'complete' });
      // The real backpressure assertion: a slow consumer must not let the body
      // pile up in memory. Measured, this peaks around 128 KB — one HTTP/2 window
      // plus a buffer. Stop pausing the source and it reaches 8.3 MB, i.e. the
      // entire response held in memory while the consumer dawdles.
      expect(peakBuffered).toBeLessThan(1024 * 1024);
    } finally {
      transport.close();
      await closeServer(server);
    }
  }, 60_000);
});
