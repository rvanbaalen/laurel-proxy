import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { LaurelProxyServer } from '../../src/server/index.js';
import { CertificateAuthority } from '../../src/server/ssl.js';
import { Database } from '../../src/storage/db.js';
import { WsFrameDecoder } from '../../src/server/ws-frames.js';
import { DEFAULT_CONFIG } from '../../src/shared/types.js';
import type { Config, RequestRecord, WebSocketMessage } from '../../src/shared/types.js';
import { encodeFrame } from '../helpers/ws-frames.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptFor(key: string): string {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

interface EchoServer {
  server: http.Server | https.Server;
  port: number;
}

interface EchoOptions {
  /**
   * Text frame written in the same call as the 101. That puts it in the same
   * TCP segment, which is how it reaches the proxy as the upstream `head`
   * buffer rather than as ordinary post-handshake traffic.
   */
  greeting?: string;
  tls?: { cert: string; key: string };
}

/** Minimal RFC 6455 server: accepts the handshake, echoes text frames. */
function startEchoServer(opts: EchoOptions = {}): Promise<EchoServer> {
  const server = opts.tls ? https.createServer(opts.tls) : http.createServer();
  server.on('upgrade', (req, socket: net.Socket) => {
    const handshake = Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptFor(req.headers['sec-websocket-key'] as string)}\r\n\r\n`,
    );
    socket.write(
      opts.greeting
        ? Buffer.concat([handshake, encodeFrame('text', Buffer.from(opts.greeting))])
        : handshake,
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

interface ByteSink extends EchoServer {
  /** Everything received after the handshake, undecoded. */
  bytes(): Buffer;
  waitForBytes(total: number): Promise<void>;
}

/**
 * Accepts the handshake and then collects raw bytes without decoding them, so a
 * stream the proxy's decoder refuses can still be compared byte for byte.
 */
function startByteSink(): Promise<ByteSink> {
  const chunks: Buffer[] = [];
  const waiters: { total: number; resolve: () => void }[] = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket: net.Socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptFor(req.headers['sec-websocket-key'] as string)}\r\n\r\n`,
    );
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const received = chunks.reduce((sum, c) => sum + c.length, 0);
      for (const waiter of waiters.splice(0)) {
        if (received >= waiter.total) waiter.resolve();
        else waiters.push(waiter);
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: (server.address() as net.AddressInfo).port,
        bytes: () => Buffer.concat(chunks),
        waitForBytes: (total) =>
          chunks.reduce((sum, c) => sum + c.length, 0) >= total
            ? Promise.resolve()
            : new Promise((r) => waiters.push({ total, resolve: r })),
      }),
    );
  });
}

interface RawWebSocket {
  /** Text payloads decoded from the server, in arrival order. */
  texts: string[];
  waitFor(count: number): Promise<void>;
  send(text: string): void;
}

/**
 * Speaks the client half of RFC 6455 by hand over an already-connected socket.
 * Needed for two things the Node HTTP client cannot do: sending frame bytes in
 * the same packet as the handshake request (`prelude`, which becomes the
 * proxy's client-side `head` buffer), and running over a CONNECT tunnel's TLS
 * socket.
 */
function rawWebSocket(
  socket: net.Socket,
  requestTarget: string,
  hostHeader: string,
  prelude?: Buffer,
): Promise<RawWebSocket> {
  const key = crypto.randomBytes(16).toString('base64');
  const request = Buffer.from(
    `GET ${requestTarget} HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );

  return new Promise((resolve, reject) => {
    const decoder = new WsFrameDecoder();
    const texts: string[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    let pending = Buffer.alloc(0);
    let handshakeDone = false;

    const feed = (chunk: Buffer): void => {
      for (const msg of decoder.push(chunk)) {
        if (msg.opcode === 'text') texts.push(msg.payload.toString());
      }
      for (const waiter of waiters.splice(0)) {
        if (texts.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (handshakeDone) {
        feed(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = pending.subarray(0, end).toString();
      const rest = pending.subarray(end + 4);
      handshakeDone = true;

      const status = Number(head.split('\r\n')[0].split(' ')[1]);
      if (status !== 101) {
        reject(new Error(`expected 101, got ${status}`));
        return;
      }
      if (/sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1] !== acceptFor(key)) {
        reject(new Error('Sec-WebSocket-Accept did not match the key we sent'));
        return;
      }

      resolve({
        texts,
        waitFor: (count) =>
          texts.length >= count
            ? Promise.resolve()
            : new Promise((r) => waiters.push({ count, resolve: r })),
        send: (text) => socket.write(encodeFrame('text', Buffer.from(text), true)),
      });
      if (rest.length > 0) feed(rest);
    });
    socket.on('error', reject);
    socket.write(prelude ? Buffer.concat([request, prelude]) : request);
  });
}

/** CONNECT through the proxy and complete TLS against its MITM certificate. */
function connectThroughProxy(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  caCertPem: string,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });
    connectReq.on('connect', (_res, socket) => {
      const tlsSocket = tls.connect(
        { socket: socket as net.Socket, host: targetHost, ca: caCertPem, servername: targetHost },
        () => resolve(tlsSocket),
      );
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function payloadText(message: WebSocketMessage): string {
  return Buffer.from(message.payload!).toString();
}

interface Recording {
  row: RequestRecord;
  messages: WebSocketMessage[];
  sent: string[];
  received: string[];
}

/** Reads back the connection row recorded for `recordedPath` plus its frames. */
function readRecording(dbPath: string, recordedPath: string): Recording {
  const db = new Database(dbPath);
  try {
    const rows = db
      .query({ limit: 200 })
      .data.filter((r) => r.kind === 'websocket' && r.path === recordedPath);
    expect(rows).toHaveLength(1);
    const messages = db.getWebSocketMessages(rows[0].id).data;
    return {
      row: rows[0],
      messages,
      sent: messages.filter((m) => m.direction === 'sent').map(payloadText),
      received: messages.filter((m) => m.direction === 'received').map(payloadText),
    };
  } finally {
    db.close();
  }
}

/** Give the proxy's 100ms batch write timer room to flush. */
function flushWrites(): Promise<void> {
  return new Promise((r) => setTimeout(r, 400));
}

describe('websocket capture', () => {
  let proxyServer: LaurelProxyServer;
  let echo: EchoServer;
  let proxyPort: number;
  let dbPath: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-ws-'));
    dbPath = path.join(tmpDir, 'data.db');
    echo = await startEchoServer();
    const config: Config = { ...DEFAULT_CONFIG, dbPath, proxyPort: 0, uiPort: 0 };
    proxyServer = new LaurelProxyServer(config);
    const ports = await proxyServer.start();
    proxyPort = ports.proxyPort;
  }, 30_000);

  afterAll(async () => {
    await proxyServer.stop();
    echo.server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('relays frames intact and records them', async () => {
    const received: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${echo.port}/socket`,
        headers: {
          host: `127.0.0.1:${echo.port}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (_res, socket, head) => {
        const decoder = new WsFrameDecoder();
        const collect = (chunk: Buffer): void => {
          for (const m of decoder.push(chunk)) {
            received.push(m.payload.toString());
            if (received.length === 2) {
              socket.end();
              resolve();
            }
          }
        };
        if (head.length > 0) collect(head);
        socket.on('data', collect);
        socket.on('error', reject);
        socket.write(encodeFrame('text', Buffer.from('hello'), true));
        socket.write(encodeFrame('text', Buffer.from('world'), true));
      });

      req.on('error', reject);
      req.end();
    });

    // Traffic fidelity: payloads round-trip byte-identical.
    expect(received).toEqual(['echo:hello', 'echo:world']);

    await flushWrites();

    const recording = readRecording(dbPath, '/socket');
    expect(recording.row.status).toBe(101);
    expect(recording.row.protocol).toBe('http');
    expect(recording.row.url).toBe(`http://127.0.0.1:${echo.port}/socket`);
    // A WebSocket connection rides the `Upgrade` path, which HTTP/2 forbids
    // outright — both hops are h1.1 by construction, not by default.
    expect(recording.row.client_protocol).toBe('http/1.1');
    expect(recording.row.origin_protocol).toBe('http/1.1');
    expect(recording.sent).toEqual(['hello', 'world']);
    expect(recording.received).toEqual(['echo:hello', 'echo:world']);
    expect(recording.messages.every((m) => m.opcode === 'text')).toBe(true);
    expect(recording.messages.every((m) => m.truncated === 0)).toBe(true);
  }, 20_000);

  it('observes bytes that arrive with either handshake in the right direction', async () => {
    const greeter = await startEchoServer({ greeting: 'greet' });
    const socket = net.connect(proxyPort, '127.0.0.1');
    await once(socket, 'connect');
    try {
      const ws = await rawWebSocket(
        socket,
        `http://127.0.0.1:${greeter.port}/head`,
        `127.0.0.1:${greeter.port}`,
        // Sent in the request's own packet, so the proxy sees it as `head`.
        encodeFrame('text', Buffer.from('early'), true),
      );
      await ws.waitFor(2);
      // 'greet' rode along with the 101 (upstream head), 'early' rode along
      // with the request (client head) and came back echoed. Both relayed.
      expect(ws.texts).toEqual(['greet', 'echo:early']);
    } finally {
      socket.end();
    }

    await flushWrites();

    const recording = readRecording(dbPath, '/head');
    expect(recording.sent).toEqual(['early']);
    expect(recording.received).toEqual(['greet', 'echo:early']);
    greeter.server.close();
  }, 20_000);

  it('relays a frame that overflows the socket write buffer', async () => {
    // 2 MB is past the point where socket.write() starts returning false on
    // loopback, so the pump's drain wait is on the hot path here, and every
    // frame spans many chunks — the observer has to reassemble what the relay
    // forwards piecemeal. It also exceeds the default 1 MiB body cap, so the
    // recording is clipped while the relay still carries every byte.
    const long = crypto.randomBytes(1_000_000).toString('hex');
    const socket = net.connect(proxyPort, '127.0.0.1');
    await once(socket, 'connect');
    try {
      const ws = await rawWebSocket(
        socket,
        `http://127.0.0.1:${echo.port}/large`,
        `127.0.0.1:${echo.port}`,
      );
      ws.send(long);
      await ws.waitFor(1);
      expect(ws.texts[0]).toBe(`echo:${long}`);
    } finally {
      socket.end();
    }

    await flushWrites();

    const recording = readRecording(dbPath, '/large');
    // One reassembled message per direction, clipped at the body cap.
    const sent = recording.messages.filter((m) => m.direction === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].size).toBe(long.length);
    expect(sent[0].truncated).toBe(1);
    // Hex, so one character per byte: slicing the string matches the clip.
    expect(payloadText(sent[0])).toBe(long.slice(0, DEFAULT_CONFIG.maxBodySize));
  }, 30_000);

  it('keeps relaying after the frame decoder gives up on a direction', async () => {
    const sink = await startByteSink();
    const before = encodeFrame('text', Buffer.from('before'), true);
    // RSV1 set. The relay strips Sec-WebSocket-Extensions, so a set RSV bit means
    // the decoder's assumptions are broken: it rejects the frame and latches
    // failed, which must degrade the recording and nothing else.
    const reserved = encodeFrame('text', Buffer.from('reserved'), true);
    reserved[0] |= 0x40;
    const after = encodeFrame('text', Buffer.from('after'), true);
    const expected = Buffer.concat([before, reserved, after]);

    const socket = net.connect(proxyPort, '127.0.0.1');
    await once(socket, 'connect');
    try {
      await rawWebSocket(socket, `http://127.0.0.1:${sink.port}/rsv`, `127.0.0.1:${sink.port}`);
      socket.write(before);
      socket.write(reserved);
      socket.write(after);
      await sink.waitForBytes(expected.length);
      // Byte-identical, including the frame the decoder refused and everything
      // after it: a recording that gave up must not cost the application a byte.
      expect(sink.bytes().equals(expected)).toBe(true);
    } finally {
      socket.end();
    }

    await flushWrites();

    const recording = readRecording(dbPath, '/rsv');
    // Recording stops at the rejected frame. 'after' is missing rather than
    // misattributed — a wrong frame boundary would be worse than a lost frame.
    expect(recording.sent).toEqual(['before']);
    sink.server.close();
  }, 20_000);

  it('records a refused upgrade as an ordinary request', async () => {
    const plain = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const plainPort = (plain.address() as net.AddressInfo).port;

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${plainPort}/nope`,
        headers: {
          host: `127.0.0.1:${plainPort}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('upgrade', () => reject(new Error('upstream refused, so no upgrade may be relayed')));
      req.on('error', reject);
      req.end();
    });

    expect(response.status).toBe(426);
    expect(response.body).toBe('Upgrade Required');

    await flushWrites();

    const db = new Database(dbPath);
    try {
      const rows = db.query({ limit: 200 }).data.filter((r) => r.path === '/nope');
      expect(rows).toHaveLength(1);
      // A refused upgrade is an ordinary HTTP exchange, not a connection.
      expect(rows[0].kind).toBe('http');
      expect(rows[0].status).toBe(426);
      // Still reached via `Upgrade` over the plain http/https transport, so
      // both hops are h1.1 by construction even though the upgrade itself
      // was refused.
      expect(rows[0].client_protocol).toBe('http/1.1');
      expect(rows[0].origin_protocol).toBe('http/1.1');
      expect(Buffer.from(rows[0].response_body!).toString()).toBe('Upgrade Required');
      expect(db.getWebSocketMessages(rows[0].id).total).toBe(0);
    } finally {
      db.close();
      plain.close();
    }
  }, 20_000);

  it('does not append a status line to a refusal it has begun relaying', async () => {
    // Promises 20 body bytes, sends 7, then resets. The reset reaches the proxy
    // as an 'error' on the upstream request after the refusal's head and part of
    // its body have already gone to the client, so the client must get a
    // truncated body — never one with an HTTP status line spliced into it.
    const flaky = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 20\r\n\r\npartial');
        setTimeout(() => socket.resetAndDestroy(), 50);
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r));
    const flakyPort = (flaky.address() as net.AddressInfo).port;

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${flakyPort}/half`,
        headers: {
          host: `127.0.0.1:${flakyPort}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });
      let received = '';
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => { received += chunk; });
        res.on('end', () => resolve(received));
        res.on('aborted', () => resolve(received));
        res.on('error', () => resolve(received));
      });
      req.on('upgrade', () => reject(new Error('upstream refused, so no upgrade may be relayed')));
      req.on('error', () => resolve(received));
      req.end();
    });

    expect(body).toBe('partial');

    await flushWrites();

    const db = new Database(dbPath);
    try {
      // A half-transferred response goes unrecorded rather than being recorded
      // as if it completed.
      expect(db.query({ limit: 200 }).data.filter((r) => r.path === '/half')).toHaveLength(0);
    } finally {
      db.close();
      flaky.close();
    }
  }, 20_000);

  it('captures wss:// through the CONNECT tunnel', async () => {
    const ca = new CertificateAuthority(path.join(tmpDir, 'ca'));
    ca.init();
    const secure = await startEchoServer({ tls: ca.getCertForHost('localhost') });
    const tlsSocket = await connectThroughProxy(
      proxyPort,
      'localhost',
      secure.port,
      fs.readFileSync(ca.getCaCertPath(), 'utf-8'),
    );
    try {
      const ws = await rawWebSocket(tlsSocket, '/wss', 'localhost');
      ws.send('secure');
      await ws.waitFor(1);
      expect(ws.texts).toEqual(['echo:secure']);
    } finally {
      tlsSocket.end();
    }

    await flushWrites();

    const recording = readRecording(dbPath, '/wss');
    expect(recording.row.status).toBe(101);
    expect(recording.row.protocol).toBe('https');
    // The recorded URL keeps the https scheme; replay maps https:→wss: itself.
    // The non-default port has to survive: it is the only thing that points a
    // replay of this capture at the server that produced it.
    expect(recording.row.url).toBe(`https://localhost:${secure.port}/wss`);
    expect(recording.sent).toEqual(['secure']);
    expect(recording.received).toEqual(['echo:secure']);
    secure.server.close();
  }, 30_000);
});

describe('websocket capture with a small body cap', () => {
  let proxyServer: LaurelProxyServer;
  let echo: EchoServer;
  let proxyPort: number;
  let dbPath: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-ws-cap-'));
    dbPath = path.join(tmpDir, 'data.db');
    echo = await startEchoServer();
    const config: Config = {
      ...DEFAULT_CONFIG,
      dbPath,
      proxyPort: 0,
      uiPort: 0,
      maxBodySize: 8,
    };
    proxyServer = new LaurelProxyServer(config);
    proxyPort = (await proxyServer.start()).proxyPort;
  }, 30_000);

  afterAll(async () => {
    await proxyServer.stop();
    echo.server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clips recorded payloads at maxBodySize while relaying them in full', async () => {
    const long = '0123456789abcdefghij';
    const socket = net.connect(proxyPort, '127.0.0.1');
    await once(socket, 'connect');
    try {
      const ws = await rawWebSocket(
        socket,
        `http://127.0.0.1:${echo.port}/capped`,
        `127.0.0.1:${echo.port}`,
      );
      ws.send(long);
      await ws.waitFor(1);
      // Capping is a recording concern only: the relay still carries every byte.
      expect(ws.texts).toEqual([`echo:${long}`]);
    } finally {
      socket.end();
    }

    await flushWrites();

    const recording = readRecording(dbPath, '/capped');
    const sent = recording.messages.filter((m) => m.direction === 'sent');
    const received = recording.messages.filter((m) => m.direction === 'received');
    expect(sent).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(payloadText(sent[0])).toBe('01234567');
    expect(sent[0].size).toBe(long.length);
    expect(sent[0].truncated).toBe(1);
    expect(payloadText(received[0])).toBe('echo:012');
    expect(received[0].size).toBe(`echo:${long}`.length);
    expect(received[0].truncated).toBe(1);
  }, 20_000);
});
