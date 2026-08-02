import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { handleWebSocketUpgrade } from './websocket.js';
import type { WebSocketDeps } from './websocket.js';
import { resolveHttpTarget } from './exchange.js';
import { DEFAULT_CONFIG } from '../shared/types.js';
import type { Config } from '../shared/types.js';
import type { Throttler } from './throttle.js';
import { startRawWsServer, echoHandler } from '../../tests/helpers/ws-server.js';
import { encodeFrame } from '../../tests/helpers/ws-frames.js';
import { watchProcessErrors } from '../../tests/helpers/process-errors.js';

/**
 * These tests replace the recording half of `WebSocketDeps` with versions that
 * fail, which is why they call `handleWebSocketUpgrade` directly instead of
 * going through `ProxyServer` — `ProxyServer` builds those deps itself.
 *
 * Every assertion has the same two halves: the application's bytes are intact,
 * and nothing reached the process-level error channels. The second half is the
 * one that matters here, because on the upgrade path the recording runs inside
 * an EventEmitter handler, where an escaping throw is the end of the proxy.
 */

const WAIT_MS = 3000;

interface RawClient {
  socket: net.Socket;
  /** The response head, once one has arrived. */
  head(): string;
  /** Everything after the response head, undecoded. */
  body(): Buffer;
  waitForHead(): Promise<void>;
  waitForBody(bytes: number): Promise<void>;
  waitForClose(): Promise<void>;
}

/**
 * Speaks the client half of an upgrade by hand and never decodes anything.
 *
 * Raw bytes are the point: a relay that alters, drops or reorders a byte has
 * broken its contract, and comparing against a frame this test built itself
 * keeps the assertion independent of the decoder — which one of these tests
 * deliberately breaks.
 */
function connectUpgrade(proxyPort: number, requestTarget: string, hostHeader: string): RawClient {
  const socket = net.connect(proxyPort, '127.0.0.1');
  socket.on('error', () => {});

  let received = Buffer.alloc(0);
  let closed = false;
  interface Waiter {
    what: string;
    done: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  }
  const waiters: Waiter[] = [];
  const check = (): void => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.done()) waiter.resolve();
      else if (closed) waiter.reject(new Error(`connection closed before ${waiter.what}`));
      else waiters.push(waiter);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    check();
  });
  socket.on('close', () => {
    closed = true;
    check();
  });

  socket.write(
    `GET ${requestTarget} HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n',
  );

  const headEnd = (): number => received.indexOf('\r\n\r\n');
  const wait = (what: string, done: () => boolean): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what}; got ${received.length} bytes`)),
        WAIT_MS,
      );
      waiters.push({
        what,
        done,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      check();
    });

  return {
    socket,
    head: () => received.subarray(0, Math.max(headEnd(), 0)).toString(),
    body: () => (headEnd() === -1 ? Buffer.alloc(0) : received.subarray(headEnd() + 4)),
    waitForHead: () => wait('the response head', () => headEnd() !== -1),
    waitForBody: (bytes) =>
      wait(`${bytes} body bytes`, () => headEnd() !== -1 && received.length - headEnd() - 4 >= bytes),
    waitForClose: () => wait('the connection to close', () => closed),
  };
}

interface Harness {
  port: number;
  close(): void;
}

/**
 * The smallest thing that dispatches upgrades the way `ProxyServer` does:
 * straight into `handleWebSocketUpgrade`, with no try/catch of its own, so a
 * throw that escapes the recording boundary reaches the process exactly as it
 * would in production.
 */
function startProxy(
  deps: WebSocketDeps,
  upgrade: typeof handleWebSocketUpgrade = handleWebSocketUpgrade,
): Promise<Harness> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end();
  });
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const target = resolveHttpTarget(req.url || '/');
    if (!target) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    upgrade(req, socket, head, target, deps);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          // An upgraded socket is detached from the server, so close() alone
          // would leave it — and the test process — alive.
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    );
  });
}

function passiveDeps(overrides: Partial<WebSocketDeps> = {}): WebSocketDeps {
  return { config: DEFAULT_CONFIG, onRecord: () => {}, onMessages: () => {}, ...overrides };
}

describe('handleWebSocketUpgrade recording failures', () => {
  it('keeps relaying frames when the message sink throws', async () => {
    const upstream = await startRawWsServer({ onMessage: echoHandler });
    const proxy = await startProxy(
      passiveDeps({
        onMessages: () => {
          throw new Error('message sink is down');
        },
      }),
    );
    const echo = encodeFrame('text', Buffer.from('re:hello'));

    try {
      const client = connectUpgrade(
        proxy.port,
        `http://127.0.0.1:${upstream.port}/msgs`,
        `127.0.0.1:${upstream.port}`,
      );
      await client.waitForHead();
      expect(client.head()).toContain('101');

      const escaped = await watchProcessErrors(async () => {
        client.socket.write(encodeFrame('text', Buffer.from('hello'), true));
        await client.waitForBody(echo.length);
      });

      // The observer runs inside the pump's read loop, whose catch tears the
      // connection down. An unguarded throw there would cost the application a
      // live connection over a lost frame.
      expect(client.body().equals(echo)).toBe(true);
      expect(escaped).toEqual([]);
      client.socket.destroy();
    } finally {
      proxy.close();
      upstream.close();
    }
  });

  it('keeps relaying frames when the connection row cannot be recorded', async () => {
    const upstream = await startRawWsServer({ onMessage: echoHandler });
    const proxy = await startProxy(
      passiveDeps({
        onRecord: () => {
          throw new Error('write queue is down');
        },
      }),
    );
    const echo = encodeFrame('text', Buffer.from('re:hello'));

    try {
      const client = connectUpgrade(
        proxy.port,
        `http://127.0.0.1:${upstream.port}/row`,
        `127.0.0.1:${upstream.port}`,
      );
      const escaped = await watchProcessErrors(async () => {
        await client.waitForHead();
        client.socket.write(encodeFrame('text', Buffer.from('hello'), true));
        await client.waitForBody(echo.length);
      });

      expect(client.head()).toContain('101');
      expect(client.body().equals(echo)).toBe(true);
      // The row is recorded from inside the 'upgrade' handler, so this is the
      // uncaught-exception case rather than the dropped-rejection one.
      expect(escaped).toEqual([]);
      client.socket.destroy();
    } finally {
      proxy.close();
      upstream.close();
    }
  });

  it('keeps relaying frames when the record cannot even be built', async () => {
    // A circular header object: `JSON.stringify(clientReq.headers)` throws on it.
    // Nothing constructs a circular header map in practice — the point is that
    // the record's *construction* has to sit inside the guard rather than in the
    // argument list, where it would be evaluated before the guard was entered.
    const upstream = await startRawWsServer({ onMessage: echoHandler });
    const poison = (req: http.IncomingMessage): void => {
      (req.headers as unknown as Record<string, unknown>).loop = req.headers;
    };
    const deps = passiveDeps();
    const onRecord = vi.fn();
    const echo = encodeFrame('text', Buffer.from('re:hello'));

    const sockets = new Set<net.Socket>();
    const server = http.createServer();
    server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      sockets.add(socket);
      poison(req);
      handleWebSocketUpgrade(req, socket, head, resolveHttpTarget(req.url!)!, {
        ...deps,
        onRecord,
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const proxyPort = (server.address() as net.AddressInfo).port;

    try {
      const client = connectUpgrade(
        proxyPort,
        `http://127.0.0.1:${upstream.port}/circular`,
        `127.0.0.1:${upstream.port}`,
      );
      const escaped = await watchProcessErrors(async () => {
        await client.waitForHead();
        client.socket.write(encodeFrame('text', Buffer.from('hello'), true));
        await client.waitForBody(echo.length);
      });

      expect(client.head()).toContain('101');
      expect(client.body().equals(echo)).toBe(true);
      expect(escaped).toEqual([]);
      expect(onRecord).not.toHaveBeenCalled();
      client.socket.destroy();
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      upstream.close();
    }
  });

  it('relays a refused upgrade in full when the body capture throws', async () => {
    // `config.maxBodySize` is read by the capture bookkeeping inside the relay
    // loop — the loop whose catch destroys the client socket. A getter that
    // throws stands in for any failure in that bookkeeping.
    const config: Config = { ...DEFAULT_CONFIG };
    Object.defineProperty(config, 'maxBodySize', {
      get(): number {
        throw new Error('recording bookkeeping failed');
      },
    });
    const onRecord = vi.fn();

    const upstream = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      // Several chunks, so the bookkeeping is reached more than once and the
      // relay has to survive each time.
      res.write('first-');
      setTimeout(() => {
        res.write('second-');
        setTimeout(() => res.end('third'), 10);
      }, 10);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startProxy(passiveDeps({ config, onRecord }));

    try {
      const client = connectUpgrade(
        proxy.port,
        `http://127.0.0.1:${upstreamPort}/refused`,
        `127.0.0.1:${upstreamPort}`,
      );
      const escaped = await watchProcessErrors(async () => {
        await client.waitForBody('first-second-third'.length);
        await client.waitForClose();
      });

      expect(client.head()).toContain('426');
      expect(client.body().toString()).toBe('first-second-third');
      expect(escaped).toEqual([]);
      expect(onRecord).not.toHaveBeenCalled();
    } finally {
      proxy.close();
      upstream.close();
    }
  });

  it('closes the client out instead of the process when the refusal relay throws off the recording path', async () => {
    // `relayRefusal` is dispatched with `void`, so a throw from anywhere in it
    // that its own guards don't cover is an unhandled rejection — a process exit
    // on Node 22. The latency delay is such a place: it is awaited before
    // anything has been written to the client, outside every recording guard.
    // Driving it through the public `throttle` dep stands in for any future
    // unguarded throw in the same window.
    const onRecord = vi.fn();
    const upstream = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('upgrade required');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startProxy(passiveDeps({
      onRecord,
      throttle: {
        up: { consume: async () => {} },
        down: { consume: async () => {} },
        delayLatency: async () => { throw new Error('latency injection exploded'); },
      } as unknown as Throttler,
    }));

    try {
      const client = connectUpgrade(
        proxy.port,
        `http://127.0.0.1:${upstreamPort}/refused-throwing`,
        `127.0.0.1:${upstreamPort}`,
      );
      const escaped = await watchProcessErrors(async () => {
        // The client must not be left holding an open socket until its own
        // timeout: a reset is all that can be said this late, but silence is not
        // an option. `waitForClose` rejects on its own 3s deadline if it hangs.
        await client.waitForClose();
      });

      expect(escaped).toEqual([]);
      // Nothing was relayed and nothing was recorded — the exchange is lost, as
      // designed. Only the process and the client's attention are protected.
      expect(client.head()).toBe('');
      expect(onRecord).not.toHaveBeenCalled();
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});

describe('handleWebSocketUpgrade with an unusable frame decoder', () => {
  afterEach(() => {
    vi.doUnmock('./ws-frames.js');
    vi.resetModules();
  });

  it('keeps relaying frames when the decoder cannot be constructed', async () => {
    // The decoders are recording state, so building them has to happen inside
    // the guard like everything else the recording needs. Mocking the
    // constructor is the only way to make that observable; the module registry
    // is reset so `websocket.ts` re-binds against the mock, which is why this
    // test imports it dynamically while the rest of the file does not.
    vi.resetModules();
    vi.doMock('./ws-frames.js', () => ({
      WsFrameDecoder: class {
        constructor() {
          throw new Error('decoder construction failed');
        }
      },
    }));
    const { handleWebSocketUpgrade: subject } = await import('./websocket.js');

    const upstream = await startRawWsServer({ onMessage: echoHandler });
    const onMessages = vi.fn();
    const proxy = await startProxy(passiveDeps({ onMessages }), subject);
    const echo = encodeFrame('text', Buffer.from('re:hello'));

    try {
      const client = connectUpgrade(
        proxy.port,
        `http://127.0.0.1:${upstream.port}/nodecoder`,
        `127.0.0.1:${upstream.port}`,
      );
      const escaped = await watchProcessErrors(async () => {
        await client.waitForHead();
        client.socket.write(encodeFrame('text', Buffer.from('hello'), true));
        await client.waitForBody(echo.length);
      });

      expect(client.head()).toContain('101');
      expect(client.body().equals(echo)).toBe(true);
      expect(escaped).toEqual([]);
      expect(onMessages).not.toHaveBeenCalled();
      client.socket.destroy();
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});
