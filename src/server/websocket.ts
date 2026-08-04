import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { WsFrameDecoder } from './ws-frames.js';
import type { WsMessage } from './ws-frames.js';
import { waitForDrain } from './stream-utils.js';
import { recordSafely } from '../shared/never-fatal.js';
import type { ExchangeTarget } from './exchange.js';
import type { Throttler, RateLimiter } from './throttle.js';
import type { Config, RequestRecord, WebSocketMessage } from '../shared/types.js';

export interface WebSocketDeps {
  config: Config;
  onRecord: (record: RequestRecord) => void;
  onMessages: (messages: WebSocketMessage[]) => void;
  throttle?: Throttler;
}

type Direction = 'sent' | 'received';

/** Hands one chunk of one direction to the recorder. Never touches the relay. */
type Observer = (direction: Direction, chunk: Buffer) => void;

/**
 * Forwards a client upgrade request upstream and, if upstream accepts it, turns
 * the two sockets into a byte relay that records the frames it carries.
 *
 * The relay is the contract: bytes cross in both directions untouched, and
 * everything to do with recording hangs off a passive observer that cannot
 * reach back into the byte path. A decoding bug may spoil a recording; it can
 * never corrupt what the application sees.
 */
export function handleWebSocketUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  target: ExchangeTarget,
  deps: WebSocketDeps,
): void {
  // Minted before either outcome so both share the same id; randomUUID only
  // fails if the CSPRNG is gone, which would already break cert generation.
  const id = randomUUID();
  const startTime = Date.now();
  const { config } = deps;

  // Lazily built so construction happens inside whichever recordSafely guard
  // calls it; a throw here would otherwise be an uncaught EventEmitter exception.
  const requestFields = () => ({
    id,
    timestamp: startTime,
    method: clientReq.method || 'GET',
    url: target.url,
    host: target.hostname,
    // Query string included, matching what the HTTP exchange path records.
    path: target.path,
    protocol: target.protocol,
    request_headers: JSON.stringify(clientReq.headers),
    request_body: null,
    request_size: 0,
  });

  const upstreamHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
  delete upstreamHeaders['proxy-connection'];
  delete upstreamHeaders['proxy-authorization'];
  // Suppress permessage-deflate: with no extension negotiated, every relayed
  // frame stays plaintext, which is what makes passive decoding possible at all.
  delete upstreamHeaders['sec-websocket-extensions'];
  if (target.protocol === 'https') upstreamHeaders.host = target.hostname;

  const transport = target.protocol === 'https' ? https : http;
  const upstreamReq = transport.request({
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: clientReq.method,
    headers: upstreamHeaders,
    ...(target.protocol === 'https' ? { rejectUnauthorized: false } : {}),
  });

  // Once a status line is written the socket carries frames or a response
  // body; these flags track whether it's still safe to prepend one.
  let upgraded = false;
  let responseStarted = false;
  let upstreamSocket: net.Socket | null = null;

  upstreamReq.on('upgrade', (upstreamRes, socket: net.Socket, upstreamHead: Buffer) => {
    upgraded = true;
    upstreamSocket = socket;

    // Replayed verbatim so the client validates the server's own
    // Sec-WebSocket-Accept against the key the client itself chose.
    clientSocket.write(serializeHead(upstreamRes));

    // Recorded here before any frame, so a reader never sees an orphan frame;
    // built inside the guard because an argument expression that throws would be uncaught.
    recordSafely(() =>
      deps.onRecord({
        ...requestFields(),
        kind: 'websocket',
        status: upstreamRes.statusCode ?? 101,
        response_headers: JSON.stringify(upstreamRes.headers),
        response_body: null,
        response_size: 0,
        duration: Date.now() - startTime,
        content_type: 'websocket',
        truncated: 0,
        // Both hops are guaranteed h1.1: HTTP/2 forbids the `Upgrade` header, and
        // this path never goes through the ALPN-negotiated UpstreamTransport.
        client_protocol: 'http/1.1',
        origin_protocol: 'http/1.1',
      }),
    );

    const observe = makeObserver(id, config, deps.onMessages);

    // upstreamHead ('received') and head ('sent') are pre-handshake bytes already
    // read; both are observed and written before the pumps start to preserve order.
    if (upstreamHead?.length) {
      observeSafely(observe, 'received', upstreamHead);
      clientSocket.write(upstreamHead);
    }
    if (head?.length) {
      observeSafely(observe, 'sent', head);
      socket.write(head);
    }

    relay(clientSocket, socket, observe, deps.throttle);
  });

  /**
   * Upstream answered with a response instead of an upgrade. That is an
   * ordinary HTTP exchange: relay it and record it as one.
   */
  const relayRefusal = async (upstreamRes: http.IncomingMessage): Promise<void> => {
    // Attached before the first await, since an unheard 'error' event here would
    // be an uncaught exception; the loop below handles its own errors separately.
    upstreamRes.on('error', () => {});
    await deps.throttle?.delayLatency();
    // Node hands us an already-decoded body, so relaying upstream's own
    // Transfer-Encoding header would corrupt it; Connection: close + end() delimits it instead.
    responseStarted = true;
    clientSocket.write(
      serializeHead(upstreamRes, ['Connection: close'], ['transfer-encoding', 'connection']),
    );

    const captured: Buffer[] = [];
    let capturedLength = 0;
    let responseSize = 0;
    try {
      for await (const chunk of upstreamRes as AsyncIterable<Buffer>) {
        // Guarded separately: a bookkeeping failure here must not trip the
        // outer catch, which would abort an otherwise-healthy transfer.
        recordSafely(() => {
          responseSize += chunk.length;
          if (capturedLength < config.maxBodySize) {
            const slice = chunk.subarray(0, config.maxBodySize - capturedLength);
            captured.push(slice);
            capturedLength += slice.length;
          }
        });
        await deps.throttle?.down.consume(chunk.length);
        if (!clientSocket.write(chunk)) await waitForDrain(clientSocket);
      }
    } catch {
      // A half-transferred response recorded as complete would be misleading,
      // so this exchange goes unrecorded — same rule as the HTTP path.
      clientSocket.destroy();
      return;
    }
    clientSocket.end();

    // Built inside the guard, as above: relayRefusal runs via `void`, so an
    // uncaught rejection here becomes a Node process exit.
    recordSafely(() => {
      const body = Buffer.concat(captured);
      deps.onRecord({
        ...requestFields(),
        kind: 'http',
        status: upstreamRes.statusCode ?? 0,
        response_headers: JSON.stringify(upstreamRes.headers),
        response_body: body.length > 0 ? body : null,
        response_size: responseSize,
        duration: Date.now() - startTime,
        content_type: (upstreamRes.headers['content-type'] || '').split(';')[0].trim() || null,
        truncated: responseSize > config.maxBodySize ? 1 : 0,
        // Same reasoning as the accepted-upgrade row: reached via an Upgrade
        // request over plain http/https, so both hops are h1.1 by construction.
        client_protocol: 'http/1.1',
        origin_protocol: 'http/1.1',
      });
    });
  };

  /**
   * The net under the refusal relay, mirroring `ProxyServer.dispatchExchange`.
   *
   * `relayRefusal` is started with `void`, so anything it throws outside the
   * guards it already has is an unhandled rejection and therefore a process exit.
   * A lost refusal recording is the acceptable cost; the process is not. There is
   * no `ServerResponse` here to write a status onto — this socket has either
   * carried a response head already or is about to carry nothing at all — so the
   * client is told by the only means left, a reset, rather than being left to
   * wait out its own timeout.
   */
  upstreamReq.on('response', (upstreamRes) => {
    void relayRefusal(upstreamRes).catch(() => {
      try { clientSocket.destroy(); } catch { /* nothing left to try */ }
    });
  });

  upstreamReq.on('error', () => {
    // Mirrors the HTTP path's 502 so the client gets an answer rather than a
    // bare reset — but only while it is still waiting for one.
    if (upgraded || responseStarted || clientSocket.destroyed) {
      clientSocket.destroy();
      return;
    }
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });

  clientSocket.on('error', () => {
    upstreamReq.destroy();
    upstreamSocket?.destroy();
  });

  upstreamReq.end();
}

/** Re-serializes a response head so the client sees upstream's own wording. */
function serializeHead(
  res: http.IncomingMessage,
  extra: string[] = [],
  drop: string[] = [],
): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (drop.includes(res.rawHeaders[i].toLowerCase())) continue;
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  }
  lines.push(...extra);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Wires up both directions of the relay with separate pumps that share only
 * the observer, which holds no socket; either socket's error tears down
 * the peer, since a half-broken tunnel has nothing left to relay.
 */
function relay(
  clientSocket: net.Socket,
  upstreamSocket: net.Socket,
  observe: Observer,
  throttle?: Throttler,
): void {
  // The caller already destroys this socket when the client errors; this is the
  // mirror image for the socket the caller never sees.
  upstreamSocket.on('error', () => clientSocket.destroy());
  void pump(clientSocket, upstreamSocket, observe, 'sent', throttle?.up);
  void pump(upstreamSocket, clientSocket, observe, 'received', throttle?.down);
}

/**
 * The recording boundary for frames.
 *
 * A thrown exception is control flow: left unguarded it would abort the pump's
 * read loop and half-close the peer, which means a bug anywhere in the recording
 * path — the decoder, the id generation, the write queue, an SSE subscriber —
 * would kill a live application connection. That is the one thing the relay must
 * never do, so the guarantee is made here, at the call site, rather than left to
 * every future edit of the observer to preserve.
 */
function observeSafely(observe: Observer, direction: Direction, chunk: Buffer): void {
  recordSafely(() => observe(direction, chunk));
}

/**
 * Relays one direction byte for byte. Observation cannot influence what is
 * written: the chunk handed to the observer is the one that arrived, the
 * observer's return value is ignored, and its exceptions are absorbed.
 */
async function pump(
  from: net.Socket,
  to: net.Socket,
  observe: Observer,
  direction: Direction,
  limiter?: RateLimiter,
): Promise<void> {
  try {
    for await (const chunk of from as AsyncIterable<Buffer>) {
      observeSafely(observe, direction, chunk);
      // `for await` already handles read-side backpressure; the optional
      // limiter call below simply no-ops when throttling is absent (see Throttler).
      await limiter?.consume(chunk.length);
      if (!to.write(chunk)) await waitForDrain(to);
    }
  } catch {
    // Either side can vanish mid-stream. The half-close below is guarded, and
    // the peer's error handler destroys whatever is left.
  }
  // Ended by exactly one pump (its reader), so never twice; the guard also
  // avoids end() on an already-destroyed socket, which raises an unhandled 'error'.
  if (!to.destroyed && !to.writableEnded) to.end();
}

/**
 * Builds the passive observation half of the relay: one decoder per direction,
 * turning the frames it can read into records.
 *
 * It closes over recording state only — no socket is reachable from here — so
 * there is structurally no path from decoding back into the relayed bytes. On
 * decode failure the connection keeps relaying and only the recording degrades:
 * traffic fidelity outranks recording completeness.
 */
function makeObserver(
  requestId: string,
  config: Config,
  onMessages: (messages: WebSocketMessage[]) => void,
): Observer {
  // Built lazily inside the guard so a throwing constructor isn't an uncaught
  // exception; a failed direction latches off rather than retrying mid-stream.
  const decoders = new Map<Direction, WsFrameDecoder | null>();

  return (direction, chunk) => {
    if (!decoders.has(direction)) {
      decoders.set(direction, null);
      decoders.set(direction, new WsFrameDecoder());
    }
    const decoder = decoders.get(direction);
    if (!decoder || decoder.isFailed) return;

    let frames: WsMessage[];
    try {
      // Copied first: the decoder claims to treat input as read-only, but
      // copying keeps relay fidelity independent of that promise (one extra memcpy per chunk).
      frames = decoder.push(Buffer.from(chunk));
    } catch {
      // Defensive: the decoder reports failure through isFailed, not by
      // throwing. If that ever changes, it still must not kill the relay.
      return;
    }
    if (frames.length === 0) return;

    const timestamp = Date.now();
    onMessages(
      frames.map((frame) => ({
        id: randomUUID(),
        request_id: requestId,
        timestamp,
        direction,
        opcode: frame.opcode,
        payload:
          frame.payload.length > 0 ? frame.payload.subarray(0, config.maxBodySize) : null,
        size: frame.payload.length,
        truncated: frame.payload.length > config.maxBodySize ? 1 : 0,
      })),
    );
  };
}
