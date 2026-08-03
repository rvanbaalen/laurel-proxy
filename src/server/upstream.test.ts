import { describe, it, expect } from 'vitest';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { countingBody, fromH2ResponseHeaders, toH2RequestHeaders, UpstreamTransport } from './upstream.js';
import type { BodyStatus, UpstreamTarget } from './upstream.js';
import { watchProcessErrors } from '../../tests/helpers/process-errors.js';

const target: UpstreamTarget = {
  hostname: 'example.com',
  port: 443,
  protocol: 'https',
  path: '/thing?a=1',
};

describe('toH2RequestHeaders', () => {
  it('emits the four pseudo-headers from the target', () => {
    const h = toH2RequestHeaders(target, 'POST', {});
    expect(h[':method']).toBe('POST');
    expect(h[':path']).toBe('/thing?a=1');
    expect(h[':scheme']).toBe('https');
    expect(h[':authority']).toBe('example.com');
  });

  it('includes a non-default port in :authority', () => {
    const h = toH2RequestHeaders({ ...target, port: 8443 }, 'GET', {});
    expect(h[':authority']).toBe('example.com:8443');
  });

  it('brackets an IPv6 literal in :authority', () => {
    const h = toH2RequestHeaders({ ...target, hostname: '::1', port: 8443 }, 'GET', {});
    expect(h[':authority']).toBe('[::1]:8443');
  });

  it('folds Host into :authority and drops the header', () => {
    const h = toH2RequestHeaders(target, 'GET', { Host: 'other.example' });
    expect(h[':authority']).toBe('other.example');
    expect(h.host).toBeUndefined();
    expect(h.Host).toBeUndefined();
  });

  it('strips every header HTTP/2 forbids', () => {
    const h = toH2RequestHeaders(target, 'GET', {
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Keep-Alive': 'timeout=5',
      'Proxy-Connection': 'keep-alive',
      Upgrade: 'websocket',
      'HTTP2-Settings': 'AAMAAABkAAQAAP__',
      'X-Kept': 'yes',
    });
    for (const name of [
      'connection',
      'transfer-encoding',
      'keep-alive',
      'proxy-connection',
      'upgrade',
      'http2-settings',
    ]) {
      expect(h[name]).toBeUndefined();
    }
    expect(h['x-kept']).toBe('yes');
  });

  it('keeps TE only when it is exactly "trailers"', () => {
    expect(toH2RequestHeaders(target, 'GET', { TE: 'trailers' }).te).toBe('trailers');
    expect(toH2RequestHeaders(target, 'GET', { TE: 'gzip' }).te).toBeUndefined();
  });

  it('lowercases header names and keeps array values', () => {
    const h = toH2RequestHeaders(target, 'GET', {
      'X-Mixed-Case': 'v',
      'Set-Cookie': ['a=1', 'b=2'],
    });
    expect(h['x-mixed-case']).toBe('v');
    expect(h['X-Mixed-Case']).toBeUndefined();
    expect(h['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('drops undefined values and any caller-supplied pseudo-header', () => {
    const h = toH2RequestHeaders(target, 'GET', {
      'x-gone': undefined,
      ':path': '/injected',
      ':authority': 'evil.example',
    });
    expect('x-gone' in h).toBe(false);
    expect(h[':path']).toBe('/thing?a=1');
    expect(h[':authority']).toBe('example.com');
  });
});

describe('fromH2ResponseHeaders', () => {
  it('extracts a numeric status and removes pseudo-headers', () => {
    const { status, headers } = fromH2ResponseHeaders({
      ':status': 204,
      'content-type': 'text/plain',
      'set-cookie': ['a=1'],
    } as never);
    expect(status).toBe(204);
    expect(headers).toEqual({ 'content-type': 'text/plain', 'set-cookie': ['a=1'] });
    expect(':status' in headers).toBe(false);
  });

  it('coerces a string status, as HPACK delivers it', () => {
    expect(fromH2ResponseHeaders({ ':status': '503' } as never).status).toBe(503);
  });

  it('reports an absent or unparseable status as undefined rather than a number', () => {
    expect(fromH2ResponseHeaders({}).status).toBeUndefined();
    expect(fromH2ResponseHeaders({ ':status': 'nope' } as never).status).toBeUndefined();
  });
});

describe('UpstreamTransport', () => {
  it('starts with an empty ALPN cache and no sessions', () => {
    const t = new UpstreamTransport();
    expect(t.stats()).toEqual({ alpnEntries: 0, sessions: 0 });
    t.close();
  });

  it('close() is idempotent', () => {
    const t = new UpstreamTransport();
    t.close();
    expect(() => t.close()).not.toThrow();
  });

  /**
   * A session that gets displaced in the pool must be closed on the way out.
   *
   * The in-flight map in `acquireSession` should make displacement unreachable for
   * the case that used to cause it (concurrent cold starts — see the burst tests
   * in `tests/integration/http2-upstream.integration.test.ts`), so this drives
   * `connectSession` directly through the `connect` seam. That is the point: a
   * defensive branch nothing can currently reach is exactly the kind that rots,
   * and the failure it guards against is a live session with no reference left in
   * the map `close()` iterates — an origin socket that leaks, and an
   * `Http2Server.close()` that never calls back.
   */
  it('closes a pooled session it displaces instead of losing the reference', async () => {
    const sessions: Array<{ closeCalls: number; destroyCalls: number }> = [];
    const connect = () => {
      const session = new EventEmitter() as unknown as http2.ClientHttp2Session;
      const counters = { closeCalls: 0, destroyCalls: 0 };
      sessions.push(counters);
      Object.assign(session, {
        alpnProtocol: 'h2',
        closed: false,
        destroyed: false,
        close: () => {
          counters.closeCalls += 1;
          Object.assign(session, { closed: true });
        },
        destroy: () => {
          counters.destroyCalls += 1;
          Object.assign(session, { destroyed: true });
        },
        ref: () => session,
        unref: () => session,
        setTimeout: () => session,
      });
      setImmediate(() => session.emit('connect'));
      return session;
    };

    const transport = new UpstreamTransport({ connect });
    // `connectSession` is private, and deliberately so — this reaches past that
    // rather than widening the class's surface for one defensive test.
    const connectSession = (
      transport as unknown as {
        connectSession(key: string, target: UpstreamTarget): Promise<unknown>;
      }
    ).connectSession.bind(transport);

    try {
      await connectSession('example.com:443', target);
      await connectSession('example.com:443', target);
      expect(sessions).toHaveLength(2);
      // The first session is gone gracefully, not leaked.
      expect(sessions[0].closeCalls).toBe(1);
      expect(sessions[1].closeCalls).toBe(0);
      expect(transport.stats().sessions).toBe(1);
      transport.close();
      // And the survivor is the one `close()` can still reach.
      expect(sessions[1].destroyCalls).toBe(1);
    } finally {
      transport.close();
    }
  });
});

describe('countingBody', () => {
  /**
   * A stand-in for `ClientHttp2Stream`. Real servers cannot be made to produce
   * every ending on demand — Node's own client rejects a short declared length
   * before this code sees it, and whether a dying session emits `end` before
   * `close` is a timing detail — so these endings are driven directly.
   */
  function fakeStream(rstCode = 0) {
    const stream = new PassThrough() as unknown as http2.ClientHttp2Stream;
    Object.defineProperty(stream, 'rstCode', { value: rstCode, configurable: true });
    return stream;
  }

  async function collect(body: Readable) {
    const chunks: Buffer[] = [];
    let error: string | null = null;
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return { bytes: Buffer.concat(chunks).length, error };
  }

  it('ends cleanly and reports complete when the declared length is satisfied', async () => {
    const source = fakeStream();
    let status: BodyStatus = { state: 'pending' };
    const body = countingBody(source, 5, (s) => {
      status = s;
    });
    source.end('12345');
    expect(await collect(body)).toEqual({ bytes: 5, error: null });
    expect(status).toEqual({ state: 'complete' });
  });

  it('fails a body that ends short of its declared length', async () => {
    const source = fakeStream();
    let status: BodyStatus = { state: 'pending' };
    const body = countingBody(source, 1000, (s) => {
      status = s;
    });
    source.end('short');
    const result = await collect(body);
    expect(result.error).toMatch(/expected 1000 bytes, received 5/);
    expect(status).toEqual({ state: 'truncated', reason: 'expected 1000 bytes, received 5' });
  });

  it('fails a body whose source closes without ending', async () => {
    const source = fakeStream();
    let status: BodyStatus = { state: 'pending' };
    const body = countingBody(source, null, (s) => {
      status = s;
    });
    source.write('partial');
    // No error, no `end` — the shape a dead session leaves behind.
    setTimeout(() => source.destroy(), 5);
    const result = await collect(body);
    expect(result.error).toMatch(/closed after 7 bytes without ending/);
    expect(status.state).toBe('truncated');
  });

  it('does not end the process when a body fails before anyone has started reading it', async () => {
    // The window is real and shipped: `handleExchange` resolves the upstream
    // response, then awaits `throttle.delayLatency()` (tens to hundreds of
    // milliseconds on `laurel-proxy throttle 3g`) *before* its `for await`. A
    // truncation inside that window destroys `out` while it has no consumer and
    // therefore no 'error' listener, and an unhandled 'error' on a stream is an
    // uncaught exception — which, with nothing in `src/` installing an
    // `uncaughtException` handler, is the end of the proxy. `dispatchExchange`'s
    // `.catch()` cannot see it: it is an event, not a rejection.
    const source = fakeStream();
    let status: BodyStatus = { state: 'pending' };
    let body!: Readable;

    const escaped = await watchProcessErrors(async () => {
      body = countingBody(source, 1000, (s) => {
        status = s;
      });
      source.end('short');
      // Nobody is iterating `body` yet — this is the deferred consumption.
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(escaped).toEqual([]);
    // And the guard weakens nothing: the late consumer still throws (Node's async
    // iterator rejects from `stream.errored`) and the verdict is still truncated.
    const result = await collect(body);
    expect(result.error).toMatch(/expected 1000 bytes, received 5/);
    expect(status).toEqual({ state: 'truncated', reason: 'expected 1000 bytes, received 5' });
  });

  it('does not report a verified body as truncated when its source closes after ending', async () => {
    const source = fakeStream();
    let status: BodyStatus = { state: 'pending' };
    const body = countingBody(source, null, (s) => {
      status = s;
    });
    source.end('all-of-it');
    expect(await collect(body)).toEqual({ bytes: 9, error: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(status).toEqual({ state: 'complete' });
  });
});
