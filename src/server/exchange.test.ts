import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import http2 from 'node:http2';
import { PassThrough, Readable } from 'node:stream';
import type net from 'node:net';
import {
  failExchange,
  handleExchange,
  relayResponseHeaders,
  resolveHttpTarget,
  resolveMitmTarget,
  sendableStatus,
} from './exchange.js';
import type { ExchangeRequest, ExchangeResponse, UpstreamRequester } from './exchange.js';
import { countingBody } from './upstream.js';
import type { BodyStatus, UpstreamResponse } from './upstream.js';
import { DEFAULT_CONFIG, DEFAULT_THROTTLE } from '../shared/types.js';
import type { Config, RequestRecord } from '../shared/types.js';
import { Throttler } from './throttle.js';
import { watchProcessErrors } from '../../tests/helpers/process-errors.js';

describe('resolveHttpTarget', () => {
  it('parses an absolute-form proxy URL', () => {
    expect(resolveHttpTarget('http://example.com/a/b?c=1')).toEqual({
      hostname: 'example.com',
      port: 80,
      protocol: 'http',
      url: 'http://example.com/a/b?c=1',
      path: '/a/b?c=1',
    });
  });

  it('honours an explicit port', () => {
    expect(resolveHttpTarget('http://example.com:8080/x')?.port).toBe(8080);
  });

  it('returns null for a non-absolute URL', () => {
    expect(resolveHttpTarget('/relative')).toBeNull();
  });
});

describe('resolveMitmTarget', () => {
  it('builds an https target from CONNECT host and path', () => {
    expect(resolveMitmTarget('example.com', 443, '/a?b=2')).toEqual({
      hostname: 'example.com',
      port: 443,
      protocol: 'https',
      url: 'https://example.com/a?b=2',
      path: '/a?b=2',
    });
  });

  it('keeps a non-default port in the recorded URL and omits 443', () => {
    // The recorded URL is what replay targets — both the HTTP Repeater and
    // WebSocket replay derive their destination from it. Dropping the port
    // would silently redirect a replay of an :8443 capture to 443.
    expect(resolveMitmTarget('api.example.com', 8443, '/v1').url).toBe(
      'https://api.example.com:8443/v1',
    );
    expect(resolveMitmTarget('api.example.com', 443, '/v1').url).toBe(
      'https://api.example.com/v1',
    );
  });
});

describe('sendableStatus', () => {
  it('passes through everything Node\'s response writer accepts', () => {
    for (const status of [100, 200, 404, 500, 599, 999]) {
      expect(sendableStatus(status)).toBe(status);
    }
  });

  it('substitutes 500 for a parsed status the writer would reject', () => {
    // Node's client parser accepts any three-digit status line, so these are all
    // reachable from a real upstream: `000` parses to 0 and `042` to 42. Node's
    // server writer throws a RangeError for anything outside 100–999, and that
    // throw escapes an exchange nobody awaits — i.e. it ends the process.
    // `|| 500` would have rescued only the 0.
    expect(sendableStatus(0)).toBe(500);
    expect(sendableStatus(42)).toBe(500);
    expect(sendableStatus(99)).toBe(500);
    expect(sendableStatus(1000)).toBe(500);
    expect(sendableStatus(undefined)).toBe(500);
  });

  it('narrows to what an HTTP/2 response writer accepts for an h2 client', () => {
    // Measured on Node 22.21.1: `Http2ServerResponse.writeHead` throws
    // ERR_HTTP2_STATUS_INVALID for every one of these, while the HTTP/1.1 writer
    // takes them all. 101 is not a special case — the whole 1xx range is out.
    for (const status of [99, 100, 101, 102, 199, 600, 700, 999, 1000]) {
      expect(sendableStatus(status, 'h2')).toBe(500);
    }
    // And nothing inside the h2 range is touched.
    for (const status of [200, 204, 404, 500, 599]) {
      expect(sendableStatus(status, 'h2')).toBe(status);
    }
  });

  it('leaves the HTTP/1.1 range alone, explicitly and by default', () => {
    // The same values an h2 client cannot be sent are perfectly sendable here,
    // and the omitted-argument default has to keep meaning HTTP/1.1: every
    // pre-existing call site relies on it.
    for (const status of [100, 101, 199, 600, 999]) {
      expect(sendableStatus(status, 'http/1.1')).toBe(status);
      expect(sendableStatus(status)).toBe(status);
    }
  });
});

/**
 * The seam `handleExchange` declares, reduced to what it presents at runtime.
 *
 * Calling this *is* the compile-time assertion: the parameter types are the
 * pipeline's own, so a seam that stopped accepting one of Node's two server
 * request/response pairs would fail `npm run typecheck` here (`tsconfig.json`
 * type-checks test files). The returned shape then also proves the members exist
 * at runtime, which the types alone do not — a mistyped `destroyed` or a missing
 * `off` would otherwise surface as a hang in Task 3 rather than a failure here.
 */
function describeSeam(req: ExchangeRequest, res: ExchangeResponse): Record<string, string> {
  return {
    'req.method': typeof req.method,
    'req.url': typeof req.url,
    'req.headers': typeof req.headers,
    'req[asyncIterator]': typeof req[Symbol.asyncIterator],
    'req.stream': typeof req.stream,
    'res.stream': typeof res.stream,
    'res.headersSent': typeof res.headersSent,
    'res.writableEnded': typeof res.writableEnded,
    'res.destroyed': typeof res.destroyed,
    'res.writeHead': typeof res.writeHead,
    'res.write': typeof res.write,
    'res.end': typeof res.end,
    'res.destroy': typeof res.destroy,
    'res.on': typeof res.on,
    'res.off': typeof res.off,
  };
}

const EXPECTED_SEAM: Record<string, string> = {
  'req.method': 'string',
  'req.url': 'string',
  'req.headers': 'object',
  'req[asyncIterator]': 'function',
  // Absent on HTTP/1.1, which is what makes every `stream?.destroyed` check in
  // the pipeline provably h2-only.
  'req.stream': 'undefined',
  'res.stream': 'undefined',
  'res.headersSent': 'boolean',
  'res.writableEnded': 'boolean',
  'res.destroyed': 'boolean',
  'res.writeHead': 'function',
  'res.write': 'function',
  'res.end': 'function',
  'res.destroy': 'function',
  'res.on': 'function',
  'res.off': 'function',
};

/**
 * `Http2ServerRequest`/`Http2ServerResponse` are not subclasses of
 * `http.IncomingMessage`/`http.ServerResponse` — they are separate classes with
 * deliberately similar APIs. These pin that the pipeline's parameter types are
 * structural enough for both, which is the precondition for routing h2 through
 * the same pipeline.
 */
describe('the exchange pipeline seam', () => {
  it('is satisfied by HTTP/1.1 server request and response objects', async () => {
    let seam: Record<string, string> | null = null;
    const server = http.createServer((req, res) => {
      seam = describeSeam(req, res);
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/seam' }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end();
      });
      expect(seam).toEqual(EXPECTED_SEAM);
    } finally {
      server.close();
    }
  });

  it('is satisfied by HTTP/2 server request and response objects', async () => {
    let seam: Record<string, string> | null = null;
    // Cleartext h2 purely to get real compatibility-API objects without a
    // certificate; Task 3's client hop is h2 over an already-terminated TLS
    // socket, which produces the same two classes.
    const server = http2.createServer((req, res) => {
      seam = describeSeam(req, res);
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const session = http2.connect(`http://127.0.0.1:${port}`);

    try {
      await new Promise<void>((resolve, reject) => {
        const stream = session.request({ ':path': '/seam' });
        stream.on('error', reject);
        stream.resume();
        stream.on('end', () => resolve());
        stream.end();
      });
      // One member differs, and it is not cosmetic: `Http2ServerResponse` has no
      // `destroyed` property at all on Node 22.21.1, even though `@types/node`
      // types the class as extending `stream.Writable` and so promises one. The
      // truth lives on `res.stream.destroyed`. Pinned here rather than smoothed
      // over so that the h2 hop cannot be built on a guard that silently reads
      // `undefined` — see `DrainableStream` in `stream-utils.ts`.
      // …and `stream` is present on both halves, which is where that truth lives
      // and therefore what every h2-only guard in the pipeline keys off.
      expect(seam).toEqual({
        ...EXPECTED_SEAM,
        'res.destroyed': 'undefined',
        'req.stream': 'object',
        'res.stream': 'object',
      });
    } finally {
      session.close();
      server.close();
    }
  });
});

describe('relayResponseHeaders', () => {
  it('strips only the framing header for an HTTP/1.1 client', () => {
    // Everything else upstream said is what the client sees today. `connection`
    // in particular stays: dropping it would turn an upstream `connection: close`
    // into a kept-alive client connection, which is a behaviour change.
    expect(
      relayResponseHeaders({
        'content-type': 'text/plain',
        'transfer-encoding': 'chunked',
        connection: 'close',
        'keep-alive': 'timeout=5',
        'set-cookie': ['a=1', 'b=2'],
      }),
    ).toEqual({
      'content-type': 'text/plain',
      connection: 'close',
      'keep-alive': 'timeout=5',
      'set-cookie': ['a=1', 'b=2'],
    });
  });

  it('strips every connection-specific header for an HTTP/2 client', () => {
    // Not cosmetic: `writeHead` on an Http2ServerResponse throws
    // ERR_HTTP2_INVALID_CONNECTION_HEADERS for any of these, from a place with
    // no caller to catch it.
    expect(
      relayResponseHeaders(
        {
          'content-type': 'text/plain',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'keep-alive': 'timeout=5',
          'proxy-connection': 'keep-alive',
          upgrade: 'h2c',
          'http2-settings': 'AAMAAABkAAQAoAAAAAIAAAAA',
          te: 'gzip',
          etag: 'W/"abc"',
        },
        'h2',
      ),
    ).toEqual({ 'content-type': 'text/plain', etag: 'W/"abc"' });
  });

  it('keeps a TE of exactly trailers for an HTTP/2 client', () => {
    expect(relayResponseHeaders({ te: 'trailers' }, 'h2')).toEqual({ te: 'trailers' });
  });
});

/**
 * A response object with the members `failExchange` reads, recording what it did.
 *
 * `destroyed` is settable to `undefined` because that is the only value an
 * `Http2ServerResponse` ever has for it, and pinning the h2 shape is the point:
 * the guard used to read that property directly, which made it a no-op for every
 * h2 client while looking like it worked.
 */
function recordingResponse(
  overrides: Partial<{
    destroyed: boolean | undefined;
    stream: { destroyed: boolean };
    headersSent: boolean;
    writableEnded: boolean;
  }> = {},
): ExchangeResponse & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    destroyed: undefined,
    headersSent: false,
    writableEnded: false,
    ...overrides,
    writeHead: (status: number) => calls.push(`writeHead:${status}`),
    write: () => { calls.push('write'); return true; },
    end: (data?: string) => calls.push(`end:${data ?? ''}`),
    destroy: () => calls.push('destroy'),
    on: () => undefined,
    off: () => undefined,
  } as unknown as ExchangeResponse & { calls: string[] };
}

describe('failExchange', () => {
  it('answers a live client with a 502', () => {
    const res = recordingResponse({ destroyed: false });
    failExchange(res);
    expect(res.calls).toEqual(['writeHead:502', 'end:Bad Gateway']);
  });

  it('resets a client whose headers have already gone out', () => {
    // A status line can no longer be sent, so a reset is the only remaining way
    // to tell the client the body it is reading will not be completed.
    const res = recordingResponse({ destroyed: false, headersSent: true });
    failExchange(res);
    expect(res.calls).toEqual(['destroy']);
  });

  it('does nothing for an h2 response whose stream is already destroyed', () => {
    // The regression this pins: with `clientRes.destroyed` read directly, this
    // guard was blind for h2 — `destroyed` is `undefined` there — so a reset
    // stream got a `writeHead`/`end` pair that threw inside the surrounding
    // `catch`. Harmless, and completely meaningless. `isGone` consults
    // `res.stream`, where h2 keeps the answer.
    const res = recordingResponse({ destroyed: undefined, stream: { destroyed: true } });
    failExchange(res);
    expect(res.calls).toEqual([]);
  });

  it('still answers an h2 response whose stream is alive', () => {
    const res = recordingResponse({ destroyed: undefined, stream: { destroyed: false } });
    failExchange(res);
    expect(res.calls).toEqual(['writeHead:502', 'end:Bad Gateway']);
  });

  it('does nothing for a response that has already ended', () => {
    const res = recordingResponse({ destroyed: false, writableEnded: true });
    failExchange(res);
    expect(res.calls).toEqual([]);
  });
});

interface ProxiedResponse {
  status: number;
  body: string;
  /** False when the response was cut off instead of ending cleanly. */
  complete: boolean;
  escaped: string[];
}

/**
 * Drives one GET through `handleExchange` with the deps under test.
 *
 * The dispatch mirrors `ProxyServer` exactly — `void handleExchange(...)` — as
 * that is what makes an escaping recording failure fatal rather than merely
 * logged: the returned promise has no caller, and Node 22 defaults to
 * `--unhandled-rejections=throw`.
 */
async function runExchange(
  deps: { config: Config; onRecord: (record: RequestRecord) => void },
  respond: (res: http.ServerResponse) => void,
): Promise<ProxiedResponse> {
  const upstream = http.createServer((_req, res) => respond(res));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const proxy = http.createServer((clientReq, clientRes) => {
    const target = resolveHttpTarget(`http://127.0.0.1:${upstreamPort}${clientReq.url}`);
    if (!target) {
      clientRes.writeHead(400);
      clientRes.end();
      return;
    }
    void handleExchange(clientReq, clientRes, target, deps);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  let status = 0;
  let body = '';
  let complete = false;
  try {
    const escaped = await watchProcessErrors(
      () =>
        new Promise<void>((resolve) => {
          const req = http.request(
            { host: '127.0.0.1', port: proxyPort, path: '/body', method: 'GET' },
            (res) => {
              status = res.statusCode ?? 0;
              res.on('data', (chunk: Buffer) => { body += chunk; });
              res.on('end', () => { complete = true; resolve(); });
              res.on('aborted', () => resolve());
              res.on('error', () => resolve());
            },
          );
          req.on('error', () => resolve());
          req.end();
        }),
    );
    return { status, body, complete, escaped };
  } finally {
    proxy.close();
    upstream.close();
  }
}

describe('handleExchange recording failures', () => {
  it('serves the whole response when onRecord throws', async () => {
    const onRecord = vi.fn(() => {
      throw new Error('write queue is down');
    });

    const { status, body, complete, escaped } = await runExchange(
      { config: DEFAULT_CONFIG, onRecord },
      (res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('payload');
      },
    );

    expect(status).toBe(200);
    expect(body).toBe('payload');
    expect(complete).toBe(true);
    expect(onRecord).toHaveBeenCalledTimes(1);
    // The exchange is the product; the recording is a by-product. A failing
    // by-product may not take the process with it.
    expect(escaped).toEqual([]);
  });

  it('serves the whole response when the record cannot be built at all', async () => {
    // `maxBodySize` is read in three places that exist only for the recording:
    // the capture bookkeeping inside the streaming loop, the truncation flag and
    // the request-body clip. A getter that throws stands in for a failure in any
    // of them. None of those expressions can throw today — which is precisely
    // why the boundary has to be structural rather than a bet on the current
    // arithmetic, and why this test exists to keep it that way.
    const config: Config = { ...DEFAULT_CONFIG };
    Object.defineProperty(config, 'maxBodySize', {
      get(): number {
        throw new Error('recording bookkeeping failed');
      },
    });
    const onRecord = vi.fn();

    const { status, body, complete, escaped } = await runExchange(
      { config, onRecord },
      (res) => {
        // Several chunks, so the capture bookkeeping inside the streaming loop
        // is reached more than once and the relay has to survive each time.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('first-');
        setTimeout(() => {
          res.write('second-');
          setTimeout(() => res.end('third'), 10);
        }, 10);
      },
    );

    expect(status).toBe(200);
    expect(body).toBe('first-second-third');
    expect(complete).toBe(true);
    expect(escaped).toEqual([]);
    // Losing the row is the acceptable half of the trade.
    expect(onRecord).not.toHaveBeenCalled();
  });
});

/**
 * A transport whose response body ends cleanly while its own verdict on that
 * body is whatever the test says.
 *
 * That combination is not contrived: it is precisely what HTTP/2 produces. When a
 * session or socket dies mid-body, Node's h2 client pushes `null` and the
 * readable *ends* — measured on Node 22.21.1 and documented in `upstream.ts` — so
 * `bodyStatus()` is the only thing standing between a seven-byte fragment of an
 * eight-megabyte response and a row that claims it was a complete 200.
 */
function stubUpstream(
  body: string,
  bodyStatus: BodyStatus,
  protocol: 'http/1.1' | 'h2' = 'http/1.1',
): UpstreamRequester {
  return {
    request: async (): Promise<UpstreamResponse> => ({
      protocol,
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Readable.from([Buffer.from(body)]),
      bodyStatus: () => bodyStatus,
    }),
  };
}

/** Drives one GET through `handleExchange` against an injected transport. */
async function runWithUpstream(
  upstream: UpstreamRequester,
  onRecord: (record: RequestRecord) => void,
  clientProtocol?: 'http/1.1' | 'h2',
): Promise<{ status: number; body: string; complete: boolean }> {
  const proxy = http.createServer((clientReq, clientRes) => {
    const target = resolveHttpTarget(`http://127.0.0.1:1${clientReq.url}`);
    if (!target) {
      clientRes.writeHead(400);
      clientRes.end();
      return;
    }
    void handleExchange(clientReq, clientRes, target, {
      config: DEFAULT_CONFIG,
      onRecord,
      upstream,
      clientProtocol,
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const port = (proxy.address() as net.AddressInfo).port;

  let status = 0;
  let body = '';
  let complete = false;
  try {
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/x' }, (res) => {
        status = res.statusCode ?? 0;
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => { complete = true; resolve(); });
        res.on('error', () => resolve());
      });
      req.on('error', () => resolve());
      req.end();
    });
    // The record is queued after the last byte is written, so give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { status, body, complete };
  } finally {
    proxy.close();
  }
}

describe('handleExchange truncation reporting', () => {
  it('records an exchange the transport reports as complete', async () => {
    const onRecord = vi.fn();
    const result = await runWithUpstream(stubUpstream('payload', { state: 'complete' }), onRecord);

    expect(result).toEqual({ status: 200, body: 'payload', complete: true });
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord.mock.calls[0][0]).toMatchObject({ status: 200, response_size: 7 });
  });

  it('does not record an exchange the transport reports as truncated, even though the body stream ended cleanly', async () => {
    const onRecord = vi.fn();
    const result = await runWithUpstream(
      stubUpstream('partial', { state: 'truncated', reason: 'stream reset with code 8' }),
      onRecord,
    );

    // Bytes already received are still relayed — traffic fidelity comes first,
    // and the client is entitled to what actually arrived. What must not happen
    // is a *record* that presents those bytes as the whole response.
    expect(result.body).toBe('partial');
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('does not record an exchange the transport has not finished accounting for', async () => {
    // `pending` is an honest "don't know yet". Treating unknown as complete is
    // the defect class this whole project is built around.
    const onRecord = vi.fn();
    await runWithUpstream(stubUpstream('unsure', { state: 'pending' }), onRecord);

    expect(onRecord).not.toHaveBeenCalled();
  });
});

describe('handleExchange wire protocol recording', () => {
  it('records both hops as http/1.1 when neither the client nor the origin negotiated h2', async () => {
    const onRecord = vi.fn();
    await runWithUpstream(stubUpstream('payload', { state: 'complete' }, 'http/1.1'), onRecord);

    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord.mock.calls[0][0]).toMatchObject({
      client_protocol: 'http/1.1',
      origin_protocol: 'http/1.1',
    });
  });

  it('records the client hop as h2 while the origin hop stays http/1.1 — the independent-hops case', async () => {
    // The flagship scenario this field exists for: an h2 client in front of an
    // HTTP/1.1-only origin. Each hop's value has to come from where it was
    // actually negotiated, not from each other.
    const onRecord = vi.fn();
    await runWithUpstream(
      stubUpstream('payload', { state: 'complete' }, 'http/1.1'),
      onRecord,
      'h2',
    );

    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord.mock.calls[0][0]).toMatchObject({
      client_protocol: 'h2',
      origin_protocol: 'http/1.1',
    });
  });

  it('records both hops as h2 when both negotiated it', async () => {
    const onRecord = vi.fn();
    await runWithUpstream(stubUpstream('payload', { state: 'complete' }, 'h2'), onRecord, 'h2');

    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord.mock.calls[0][0]).toMatchObject({
      client_protocol: 'h2',
      origin_protocol: 'h2',
    });
  });
});

describe('handleExchange', () => {
  it('does not record an exchange whose response stream fails mid-transfer', async () => {
    // Upstream sends a partial body, then resets the connection before it
    // ends — simulating a network failure partway through the response.
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial-data');
      setTimeout(() => res.socket?.destroy(), 30);
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const onRecord = vi.fn();
    const proxyServer = http.createServer((clientReq, clientRes) => {
      const target = resolveHttpTarget(`http://127.0.0.1:${upstreamPort}${clientReq.url}`);
      if (!target) {
        clientRes.writeHead(400);
        clientRes.end();
        return;
      }
      void handleExchange(clientReq, clientRes, target, { config: DEFAULT_CONFIG, onRecord });
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, resolve));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;

    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/reset', method: 'GET' },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
          res.on('error', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    // Give handleExchange a moment to settle after the stream error.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onRecord).not.toHaveBeenCalled();

    proxyServer.close();
    upstream.close();
  });

  it('survives an upstream body that fails during the latency injection', async () => {
    // The exact shipped window, end to end: `handleExchange` resolves the upstream
    // response, awaits `delayLatency()` — a real timer of hundreds of milliseconds
    // under `laurel-proxy throttle 3g` — and only then starts iterating. An h2 body
    // that truncates inside it destroys a stream with no consumer attached, and an
    // unhandled 'error' *event* is an uncaught exception that `dispatchExchange`'s
    // `.catch()` structurally cannot see. The body here is a real `countingBody`,
    // since the guard being tested lives inside it.
    const source = new PassThrough() as unknown as http2.ClientHttp2Stream;
    Object.defineProperty(source, 'rstCode', { value: 0, configurable: true });
    let bodyStatus: BodyStatus = { state: 'pending' };
    const upstream: UpstreamRequester = {
      request: async (): Promise<UpstreamResponse> => {
        const body = countingBody(source, 1000, (settled) => {
          bodyStatus = settled;
        });
        // Truncates well inside the 200ms latency below, i.e. before anything
        // is iterating.
        setTimeout(() => source.end('short'), 20);
        return {
          protocol: 'h2',
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body,
          bodyStatus: () => bodyStatus,
        };
      },
    };

    const onRecord = vi.fn();
    const proxyServer = http.createServer((clientReq, clientRes) => {
      const target = resolveHttpTarget(`http://127.0.0.1:1${clientReq.url}`);
      if (!target) {
        clientRes.writeHead(400);
        clientRes.end();
        return;
      }
      // Dispatched exactly as `ProxyServer` does it, `.catch()` included: that is
      // what makes this a test of whether the failure is even *reachable* by a
      // rejection handler.
      void handleExchange(clientReq, clientRes, target, {
        config: DEFAULT_CONFIG,
        onRecord,
        upstream,
        throttle: new Throttler({ ...DEFAULT_THROTTLE, enabled: true, latencyMs: 200 }),
      }).catch(() => failExchange(clientRes));
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;

    try {
      const escaped = await watchProcessErrors(
        () =>
          new Promise<void>((resolve) => {
            const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/slow' }, (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve());
              res.on('aborted', () => resolve());
              res.on('error', () => resolve());
            });
            req.on('error', () => resolve());
            req.end();
          }),
      );

      // The proxy stays up. Losing the exchange is the acceptable half of the
      // trade; the truncated body must not be recorded as a complete one either.
      expect(escaped).toEqual([]);
      expect(bodyStatus).toEqual({ state: 'truncated', reason: 'expected 1000 bytes, received 5' });
      expect(onRecord).not.toHaveBeenCalled();
    } finally {
      proxyServer.close();
    }
  });

  it('destroys the upstream body when the relay loop is never reached', async () => {
    // Only the relay loop consumes the upstream body, so anything that throws
    // between the response resolving and that loop leaks it. For h2 this is not
    // just an unread stream: `countingBody` pauses its source, holding the
    // flow-control window open, so the session's graceful idle close cannot
    // complete and the real bound becomes the origin's own timeout.
    const body = Readable.from([Buffer.from('never relayed')]);
    const upstream: UpstreamRequester = {
      request: async (): Promise<UpstreamResponse> => ({
        protocol: 'h2',
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body,
        bodyStatus: () => ({ state: 'complete' }) as BodyStatus,
      }),
    };
    // Stands in for anything in that window failing. `delayLatency` is the real
    // one with a shipped timer behind it, which is why it is the chosen vector.
    const throttle = {
      delayLatency: async () => {
        throw new Error('injected latency failure');
      },
      down: { consume: async () => {} },
      up: { consume: async () => {} },
    } as unknown as Throttler;

    const onRecord = vi.fn();
    const proxyServer = http.createServer((clientReq, clientRes) => {
      const target = resolveHttpTarget(`http://127.0.0.1:1${clientReq.url}`);
      if (!target) {
        clientRes.writeHead(400);
        clientRes.end();
        return;
      }
      void handleExchange(clientReq, clientRes, target, {
        config: DEFAULT_CONFIG,
        onRecord,
        upstream,
        throttle,
      }).catch(() => failExchange(clientRes));
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;

    try {
      const status = await new Promise<number>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/leak' }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', () => resolve(0));
        req.end();
      });

      // The behaviour that was already correct: the client still gets a 502 and
      // nothing is recorded. The fix only adds the cleanup.
      expect(status).toBe(502);
      expect(onRecord).not.toHaveBeenCalled();
      expect(body.destroyed).toBe(true);
    } finally {
      proxyServer.close();
    }
  });
});
