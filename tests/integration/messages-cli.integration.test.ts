import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { LaurelProxyServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';
import { Database } from '../../src/storage/db.js';
import { WsFrameDecoder } from '../../src/server/ws-frames.js';
import { formatWsMessages } from '../../src/cli/format.js';
import { followMessages } from '../../src/cli/commands/messages.js';
import { encodeFrame } from '../helpers/ws-frames.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptFor(key: string): string {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Minimal RFC 6455 echo server, trimmed from tests/integration/websocket.integration.test.ts. */
function startEchoServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  server.on('upgrade', (req, socket: net.Socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptFor(req.headers['sec-websocket-key'] as string)}\r\n\r\n`,
    );
    const decoder = new WsFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.opcode === 'text') {
          socket.write(encodeFrame('text', Buffer.from(`echo:${msg.payload.toString()}`)));
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port }),
    );
  });
}

/** Opens a WS connection through the proxy and returns once the 101 upgrade lands. */
function openWsThroughProxy(
  proxyPort: number,
  targetPort: number,
): Promise<{ socket: net.Socket; send: (text: string) => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: `http://127.0.0.1:${targetPort}/socket`,
      headers: {
        host: `127.0.0.1:${targetPort}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (_res, socket) => {
      resolve({ socket, send: (text: string) => socket.write(encodeFrame('text', Buffer.from(text), true)) });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Give the proxy's batched write timer room to flush ws frames to disk. */
function flushWrites(): Promise<void> {
  return new Promise((r) => setTimeout(r, 400));
}

/** Collects `event: <type>` SSE frames off a raw HTTP response body. */
function collectSse(res: http.IncomingMessage, onEvent: (type: string, data: string) => void): void {
  let buffer = '';
  res.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      let eventType = '';
      let data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (eventType && data) onEvent(eventType, data);
    }
  });
}

// Exercises the CLI's transport against a real, in-process LaurelProxyServer
// on ephemeral ports — proving the direct-DB non-follow path and the
// --follow SSE path both work against the actual server, not a mock.
// Formatter behaviour is covered by the pure unit tests in
// src/cli/format.test.ts; this covers transport and wiring only. Never boots
// `laurel-proxy start` or touches the host's real system proxy settings.
describe('laurel-proxy messages CLI transport', () => {
  let server: LaurelProxyServer;
  let echo: { server: http.Server; port: number };
  let proxyPort: number;
  let uiPort: number;
  let dbPath: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-messages-cli-'));
    dbPath = path.join(tmpDir, 'data.db');
    echo = await startEchoServer();
    const config = loadConfig({ dbPath, proxyPort: 0, uiPort: 0 });
    server = new LaurelProxyServer(config);
    const ports = await server.start();
    proxyPort = ports.proxyPort;
    uiPort = ports.uiPort;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    echo.server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'reads captured frames straight from the database while the proxy is still running',
    async () => {
      const { socket, send } = await openWsThroughProxy(proxyPort, echo.port);
      const decoder = new WsFrameDecoder();
      const received: string[] = [];
      await new Promise<void>((resolve) => {
        socket.on('data', (chunk: Buffer) => {
          for (const msg of decoder.push(chunk)) {
            received.push(msg.payload.toString());
            if (received.length === 1) resolve();
          }
        });
        send('hello');
      });
      expect(received).toEqual(['echo:hello']);
      socket.end();

      await flushWrites();

      // Opens a second Database handle onto the same file the running
      // server's Database instance already holds open — exactly what
      // `registerMessages`'s non-follow path does. WAL mode is what makes
      // this safe: a second reader must not be blocked by, or corrupt, the
      // writer's connection.
      const db = new Database(dbPath);
      try {
        const rows = db.query({ limit: 200 }).data.filter((r) => r.kind === 'websocket');
        expect(rows).toHaveLength(1);
        const record = db.getById(rows[0].id);
        expect(record?.kind).toBe('websocket');

        const result = db.getWebSocketMessages(rows[0].id);
        expect(result.total).toBe(2); // 'hello' sent, 'echo:hello' received
        const out = formatWsMessages(result, 'agent');
        const parsed = JSON.parse(out);
        expect(parsed.data.map((m: { payload: string }) => m.payload)).toEqual(
          expect.arrayContaining(['hello', 'echo:hello']),
        );
        expect(parsed.summary).toContain('2 message');
      } finally {
        db.close();
      }
    },
    20_000,
  );

  it(
    'follows live ws-message SSE events for one connection and filters out others',
    async () => {
      // Subscribe first and capture the handshake's `request` event so we
      // know the tracked connection's id before any frames are sent — the
      // row (and its SSE `event: request`) is emitted synchronously on
      // handshake, ahead of any frame the client goes on to send.
      const idPromise = new Promise<string>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: uiPort, path: '/api/events', method: 'GET' },
          (res) => {
            collectSse(res, (type, data) => {
              if (type !== 'request') return;
              const record = JSON.parse(data);
              if (record.kind === 'websocket' && record.path === '/tracked') resolve(record.id);
            });
          },
        );
        req.on('error', reject);
        req.end();
      });

      // Opened first, and left alone for the rest of the test: its frames
      // must never show up in the tracked connection's --follow output.
      const { socket: unrelatedSocket, send: sendUnrelated } = await openWsThroughProxy(proxyPort, echo.port);

      const { socket: trackedSocket, send: sendTracked } = await openTrackedConnection();
      const requestId = await idPromise;

      const lines: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
      // followMessages calls process.exit() when its SSE stream ends or
      // errors — real behaviour for the CLI, but the underlying connection
      // it opens here stays open past this test and only closes when
      // `afterAll` tears down the server. Without this guard that shutdown
      // would trigger the real process.exit() from inside our test process,
      // killing the whole Vitest worker before its own cleanup finishes.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as (code?: string | number | null) => never);
      try {
        followMessages(uiPort, requestId, 'json');
        // Let the follow request's SSE subscription register server-side
        // before any frame is sent, so this test cannot pass by racing a
        // buffered/replayed event that the implementation doesn't actually
        // provide.
        await new Promise((r) => setTimeout(r, 100));

        // Traffic on a different connection must be filtered out, not
        // mis-rendered as belonging to the tracked one.
        sendUnrelated('noise');
        await new Promise((r) => setTimeout(r, 100));

        sendTracked('tracked-payload');

        await vi.waitFor(() => {
          expect(lines.some((l) => l.includes('tracked-payload'))).toBe(true);
        }, { timeout: 5000 });
      } finally {
        logSpy.mockRestore();
        exitSpy.mockRestore();
        unrelatedSocket.end();
        trackedSocket.end();
      }

      const parsedLines = lines.map((l) => JSON.parse(l));
      expect(parsedLines.every((m) => m.direction === 'sent' || m.direction === 'received')).toBe(true);
      // Only frames from the tracked connection were printed.
      expect(lines.some((l) => l.includes('noise'))).toBe(false);

      async function openTrackedConnection() {
        return new Promise<{ socket: net.Socket; send: (t: string) => void }>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port: proxyPort,
            path: `http://127.0.0.1:${echo.port}/tracked`,
            headers: {
              host: `127.0.0.1:${echo.port}`,
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
              'Sec-WebSocket-Version': '13',
            },
          });
          req.on('upgrade', (_res, sock) => {
            resolve({ socket: sock, send: (t: string) => sock.write(encodeFrame('text', Buffer.from(t), true)) });
          });
          req.on('error', reject);
          req.end();
        });
      }
    },
    20_000,
  );
});
