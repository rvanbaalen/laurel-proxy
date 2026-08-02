import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { WsFrameDecoder } from '../../src/server/ws-frames.js';
import type { WsMessage } from '../../src/server/ws-frames.js';
import { encodeFrame } from './ws-frames.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface RawWsServer {
  port: number;
  /**
   * Stops listening *and* destroys every upgraded socket. An upgraded socket is
   * detached from the server, so `server.close()` alone would leave it — and the
   * test process — alive.
   */
  close(): void;
}

export interface RawWsServerOptions {
  /** Called for each frame decoded from the client. */
  onMessage?: (message: WsMessage, socket: net.Socket) => void;
  /** Called once per connection, immediately after the 101 is written. */
  onOpen?: (socket: net.Socket) => void;
}

/**
 * Minimal RFC 6455 server for replay tests: completes the handshake and hands
 * decoded client frames to a caller-supplied handler. Test scaffolding only —
 * `src/` never encodes frames.
 */
export function startRawWsServer(opts: RawWsServerOptions = {}): Promise<RawWsServer> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer();

  server.on('upgrade', (req, socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    const accept = crypto
      .createHash('sha1')
      .update((req.headers['sec-websocket-key'] as string) + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const decoder = new WsFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) opts.onMessage?.(message, socket);
    });

    opts.onOpen?.(socket);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    );
  });
}

/** Prefixes text payloads with `re:`; echoes binary payloads byte for byte. */
export function echoHandler(message: WsMessage, socket: net.Socket): void {
  if (message.opcode === 'text') {
    socket.write(encodeFrame('text', Buffer.from(`re:${message.payload.toString()}`)));
  } else if (message.opcode === 'binary') {
    socket.write(encodeFrame('binary', message.payload));
  }
}
