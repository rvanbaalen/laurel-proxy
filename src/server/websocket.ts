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
  // The one piece of recording state that has to exist before the guard: the
  // connection row and every frame recorded against it key off the same id, so
  // it cannot be minted inside either of them. `randomUUID` fails only when the
  // platform CSPRNG is unavailable, which would already have stopped this proxy
  // from generating a certificate.
  const id = randomUUID();
  const startTime = Date.now();
  const { config } = deps;

  // Fields both outcomes — an accepted upgrade or a refusal — record the same.
  // A function rather than an object so the building happens inside whichever
  // guard is about to use it: this runs from an EventEmitter handler, where a
  // throw is an uncaught exception, and it exists only for the recording.
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

  // Anything already written to the client socket makes it too late to send a
  // status line: after a 101 the socket carries frames, and after a refusal's
  // head it carries that response's body. Appending an HTTP status line to
  // either corrupts the stream, which is worse than truncating it.
  let upgraded = false;
  let responseStarted = false;
  let upstreamSocket: net.Socket | null = null;

  upstreamReq.on('upgrade', (upstreamRes, socket: net.Socket, upstreamHead: Buffer) => {
    upgraded = true;
    upstreamSocket = socket;

    // Replayed verbatim so the client validates the server's own
    // Sec-WebSocket-Accept against the key the client itself chose.
    clientSocket.write(serializeHead(upstreamRes));

    // Queued before any frame can be observed below. The proxy flushes the
    // request queue ahead of the frame queue on the same timer, so a reader can
    // never see a frame whose parent connection row is still missing.
    //
    // Built inside the guard, not passed into it: this runs from an EventEmitter
    // handler, so an argument expression that threw — `JSON.stringify` on
    // headers, say — would be an uncaught exception, killing the process over a
    // row it failed to write.
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
      }),
    );

    const observe = makeObserver(id, config, deps.onMessages);

    // Both handshakes can carry stream bytes past their own headers, and each
    // belongs to the direction it came from: `upstreamHead` was read from
    // upstream (server→client, 'received'), `head` from the client
    // (client→server, 'sent'). They are observed and forwarded before the pumps
    // start so neither the recording nor the relay reorders them.
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
    // Claimed before the first await: an upstream reset during the latency delay
    // would otherwise emit 'error' on an IncomingMessage nobody listens to,
    // which is an uncaught exception. The await loop below has its own handling.
    upstreamRes.on('error', () => {});
    await deps.throttle?.delayLatency();
    // Upstream's framing headers cannot be forwarded: Node hands us an already
    // decoded body, so a relayed `Transfer-Encoding: chunked` would leave the
    // client reading plain bytes as chunk headers. `Connection: close` plus the
    // end() below delimits the body unambiguously in every case.
    responseStarted = true;
    clientSocket.write(
      serializeHead(upstreamRes, ['Connection: close'], ['transfer-encoding', 'connection']),
    );

    const captured: Buffer[] = [];
    let capturedLength = 0;
    let responseSize = 0;
    try {
      for await (const chunk of upstreamRes as AsyncIterable<Buffer>) {
        // Guarded because this `try`'s catch destroys the client socket: a
        // failure in the capture bookkeeping must not abort a transfer that is
        // otherwise proceeding perfectly. Same inversion as the frame path, one
        // layer down.
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
      // Recording a half-transferred response as if it completed would be
      // actively misleading, so this exchange goes unrecorded — same rule the
      // HTTP path follows.
      clientSocket.destroy();
      return;
    }
    clientSocket.end();

    // Built inside the guard for the same reason as the accepted-upgrade row,
    // and with the same consequence if it were not: `relayRefusal` is started
    // with `void`, so a rejection from here reaches nobody and Node 22 turns it
    // into a process exit.
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
 * Wires up both directions of the byte relay.
 *
 * Each direction gets its own pump; the only thing they share is the observer,
 * which holds no socket. An error on either socket tears the peer down, since a
 * half-broken tunnel has nothing left to relay.
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
      // `for await` handles read-side backpressure; consuming from the limiter
      // here (rather than chaining off the optional call) degrades to a plain
      // no-op await when throttling is absent — see Throttler.
      await limiter?.consume(chunk.length);
      if (!to.write(chunk)) await waitForDrain(to);
    }
  } catch {
    // Either side can vanish mid-stream. The half-close below is guarded, and
    // the peer's error handler destroys whatever is left.
  }
  // Forward the half-close so the peer learns this direction is over. Each
  // socket is ended by exactly one pump — its reader — so nothing is ended
  // twice; the guard covers end() on an already-destroyed socket, which would
  // otherwise raise an unhandled 'error'.
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
  // Built on first use rather than here, so construction happens inside the
  // observer — which every call site invokes through the recording guard —
  // rather than in the EventEmitter handler that calls `makeObserver`, where a
  // throw would be an uncaught exception. A `null` entry is written first, so a
  // constructor that threw latches the direction off instead of being retried on
  // the next chunk: a decoder started mid-stream would resynchronise on the
  // wrong frame boundary, and a wrong boundary is worse than a missing frame.
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
      // Decoded from a copy. The decoder documents that it treats its input as
      // read-only; copying makes the relay's fidelity independent of that
      // promise, at the cost of one memcpy per chunk.
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
