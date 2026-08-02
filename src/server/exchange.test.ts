import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import { resolveHttpTarget, resolveMitmTarget, handleExchange, sendableStatus } from './exchange.js';
import { DEFAULT_CONFIG } from '../shared/types.js';
import type { Config, RequestRecord } from '../shared/types.js';
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
});
