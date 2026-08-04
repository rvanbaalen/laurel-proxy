import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import type { Database } from '../storage/db.js';
import type { CertificateAuthority } from './ssl.js';
import type { EventManager } from './events.js';
import type { Config, RequestRecord, WebSocketMessage } from '../shared/types.js';
import { listenWithRetry } from './port-utils.js';
import { recordSafely } from '../shared/never-fatal.js';
import { failExchange, handleExchange, resolveHttpTarget, resolveMitmTarget } from './exchange.js';
import type {
  ExchangeDeps,
  ExchangeRequest,
  ExchangeResponse,
  ExchangeTarget,
} from './exchange.js';
import { handleWebSocketUpgrade } from './websocket.js';
import type { WebSocketDeps } from './websocket.js';
import { UpstreamTransport } from './upstream.js';
import type { NegotiatedProtocol } from './upstream.js';
import type { Throttler } from './throttle.js';

/**
 * Cap on a MITM TLS handshake, after which the tunnel socket is destroyed.
 *
 * The virtual `http.Server` that would otherwise enforce a `headersTimeout`
 * isn't built until inside the `'secure'` handler, since ALPN gives
 * `alpnProtocol` no value before then — so nothing else bounds a client that
 * holds a CONNECT socket, and the certificate generated for it, open without
 * ever completing TLS. 60s matches Node's own `headersTimeout` default, which
 * is generous for a handshake.
 */
export const MITM_HANDSHAKE_TIMEOUT_MS = 60_000;

export interface ProxyServerOptions {
  /** Overrides {@link MITM_HANDSHAKE_TIMEOUT_MS}. Exists so tests need not wait a minute. */
  mitmHandshakeTimeoutMs?: number;
}

/**
 * Stands in for the line `tls.Server` runs on our behalf, and reports whether
 * that line still exists.
 *
 * `Http2Session` refuses to set up its handle while it believes TLS is still in
 * progress, and what it waits for is `secureConnect` — an event a server-side
 * socket never emits. `secureConnecting` stays `true` forever on a hand-built
 * server `TLSSocket`, because `tls.Server` is what normally clears it, in
 * `onServerSocketSecure`, just before handing the finished socket to its
 * `secureConnection` listeners. We are standing in for that listener, so we have
 * to stand in for that line too. Measured on Node 22.21.1: without it the session
 * never starts and every request on the tunnel hangs forever, with no error
 * anywhere.
 *
 * Which is exactly why the property's existence is checked rather than assumed. A
 * blind cast made a Node rename or removal of this internal field a class of
 * *silent hangs* — the single worst failure mode to debug from a bug report. The
 * boolean lets the caller fail the tunnel instead, and the unit test on a real
 * `TLSSocket` is the canary that says which Node release broke it.
 *
 * The supported alternative, if this ever has to go: `http2.createSecureServer({
 * allowHTTP1: true })` fed the raw CONNECT socket, letting one server terminate
 * TLS and branch on ALPN itself. Not a drop-in — it would have to be checked
 * against the `Upgrade`/WebSocket path, which currently depends on an
 * `http.Server` seeing the decrypted socket, and `allowHTTP1` sessions have their
 * own request/response shapes to thread through the pipeline.
 */
export function markHandshakeComplete(socket: object): boolean {
  if (!('secureConnecting' in socket)) return false;
  (socket as { secureConnecting: boolean }).secureConnecting = false;
  return true;
}

export class ProxyServer {
  private server: http.Server | null = null;
  /**
   * Owned here, not per exchange: a connection pool and ALPN-verdict cache worth reusing across requests to the same origin.
   *
   * Its lifetime has to match the server's, which is why it is created in
   * `start` and closed in `stop` alongside `server` and `sockets` — an
   * unclosed pool holds sockets open, and this process is a CLI that has to
   * be able to exit.
   */
  private upstream: UpstreamTransport | null = null;
  private sockets: Set<net.Socket> = new Set();
  private writeQueue: RequestRecord[] = [];
  private wsWriteQueue: WebSocketMessage[] = [];
  private writeTimer: ReturnType<typeof setInterval> | null = null;
  private throttler: Throttler | null = null;

  constructor(
    private db: Database,
    private ca: CertificateAuthority,
    private events: EventManager,
    private config: Config,
    private options: ProxyServerOptions = {},
  ) {}

  async start(): Promise<number> {
    this.upstream = new UpstreamTransport();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('connect', (req, clientSocket: net.Socket, head) => this.handleConnect(req, clientSocket, head));
    this.server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      const target = resolveHttpTarget(req.url || '/');
      if (!target) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      handleWebSocketUpgrade(req, socket, head, target, this.webSocketDeps);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    this.writeTimer = setInterval(() => this.flushWrites(), 100);

    const result = await listenWithRetry(this.server, this.config.proxyPort);
    return result.port;
  }

  async stop(): Promise<void> {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = null;
    }
    this.flushWrites();
    // Closed before the client sockets: an open pooled h2 session is an
    // upstream socket that would otherwise keep the event loop alive.
    if (this.upstream) {
      this.upstream.close();
      this.upstream = null;
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  get port(): number {
    if (!this.server) return 0;
    const addr = this.server.address() as net.AddressInfo | null;
    return addr?.port ?? 0;
  }

  setThrottler(throttler: Throttler): void {
    this.throttler = throttler;
  }

  /**
   * Requests are flushed before frames: a WebSocket connection row is always
   * queued before its frames, so as long as the request insert succeeds, a
   * reader can never see a frame before its parent row has landed.
   *
   * This runs from a `setInterval`, where an escaping throw is an uncaught
   * exception and therefore the end of the process — and it is the one recording
   * path a user reaches without doing anything unusual: `SQLITE_FULL` on a full
   * disk, a locked database, a corrupted file and a failed migration all throw
   * from here. A developer whose disk filled up gets a lost row, not a dead
   * proxy.
   *
   * Each batch is taken off its queue before the insert, so a failed batch is
   * **dropped rather than retried**. Putting it back would have it retried every
   * 100ms forever, growing the queue without bound and turning a transient
   * failure into a permanent one.
   *
   * The two queues are guarded separately, so a failing request insert does not
   * also cost the frames — but that is exactly what qualifies the ordering
   * guarantee above. `insertBatch` is one transaction, so a single unwritable
   * record (an oversized `response_body` raising `SQLITE_TOOBIG`, say) drops the
   * whole batch, including any WebSocket connection row in it, while the frame
   * insert on the same tick can still succeed. That leaves **orphaned
   * `websocket_messages`**: rows whose `request_id` names a `requests` row that
   * never landed. Nothing rejects them — `request_id` carries an index, not a
   * foreign key — and every reader and both retention deletes are driven off
   * `requests`, so they would be invisible and unreclaimable. `Cleanup.run()`
   * sweeps them; see `Database.deleteOrphanedWebSocketMessages`.
   */
  private flushWrites(): void {
    if (this.writeQueue.length > 0) {
      const batch = this.writeQueue;
      this.writeQueue = [];
      recordSafely(() => this.db.insertBatch(batch));
    }
    if (this.wsWriteQueue.length > 0) {
      const batch = this.wsWriteQueue;
      this.wsWriteQueue = [];
      recordSafely(() => this.db.insertWebSocketMessages(batch));
    }
  }

  private get exchangeDeps(): ExchangeDeps {
    return {
      config: this.config,
      onRecord: (record) => {
        this.writeQueue.push(record);
        this.events.push(record);
      },
      throttle: this.throttler ?? undefined,
      upstream: this.upstream ?? undefined,
    };
  }

  /** The exchange deps plus a sink for decoded frames. */
  private get webSocketDeps(): WebSocketDeps {
    return {
      ...this.exchangeDeps,
      onMessages: (messages) => {
        this.wsWriteQueue.push(...messages);
        this.events.pushWsMessages(messages);
      },
    };
  }

  /**
   * The net under the exchange pipeline.
   *
   * The recording work inside `handleExchange` is guarded record by record, but
   * the pipeline around it is not: any unexpected throw between `writeHead` and
   * `end()` rejects a promise nobody awaits, and Node 22 turns that into a
   * process exit. This is the same trade the recording guard makes one layer in —
   * lose the exchange, keep the proxy — extended to the whole dispatch, so a
   * future edit to the pipeline cannot reintroduce a process-death path by
   * throwing somewhere new. `failExchange` also closes the client out, so a lost
   * exchange is not additionally a hung client.
   */
  private dispatchExchange(
    clientReq: ExchangeRequest,
    clientRes: ExchangeResponse,
    target: ExchangeTarget,
    clientProtocol: NegotiatedProtocol = 'http/1.1',
  ): void {
    void handleExchange(clientReq, clientRes, target, { ...this.exchangeDeps, clientProtocol })
      .catch(() => failExchange(clientRes));
  }

  private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const target = resolveHttpTarget(clientReq.url || '/');
    if (!target) {
      clientRes.writeHead(400);
      clientRes.end('Bad Request');
      return;
    }
    this.dispatchExchange(clientReq, clientRes, target);
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, _head: Buffer): void {
    const [hostname, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr || '443', 10);

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    try {
      const { cert, key } = this.ca.getCertForHost(hostname);

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        cert,
        key,
        // Client protocol only; the origin's is negotiated separately, see `upstream.ts`.
        ALPNProtocols: ['h2', 'http/1.1'],
      });

      tlsSocket.on('error', () => {
        clientSocket.destroy();
      });

      // See MITM_HANDSHAKE_TIMEOUT_MS: nothing else bounds this window.
      const handshakeTimer = setTimeout(() => {
        clientSocket.destroy();
      }, this.options.mitmHandshakeTimeoutMs ?? MITM_HANDSHAKE_TIMEOUT_MS);
      // A pending handshake must not be a reason the process cannot exit.
      handshakeTimer.unref?.();
      const clearHandshakeTimer = () => clearTimeout(handshakeTimer);
      tlsSocket.once('secure', clearHandshakeTimer);
      tlsSocket.once('close', clearHandshakeTimer);
      clientSocket.once('close', clearHandshakeTimer);

      // `secure` (not `secureConnect`, client-side only) is the earliest point
      // `alpnProtocol` is set; unread bytes just sit in the socket's buffer.
      tlsSocket.once('secure', () => {
        // Exact match only: `alpnProtocol` is `false`/`null`/`undefined` when
        // ALPN wasn't offered, and all of those mean HTTP/1.1, never h2.
        if (tlsSocket.alpnProtocol === 'h2') this.serveH2Tunnel(tlsSocket, hostname, port);
        else this.serveH1Tunnel(tlsSocket, hostname, port);
      });
    } catch {
      clientSocket.end();
    }
  }

  /**
   * The HTTP/1.1 half of a MITM tunnel: a throwaway `http.Server`, never
   * listening, fed the decrypted socket via `emit('connection')`.
   *
   * One server per CONNECT is wasteful — a fresh object graph per tunnel —
   * but sharing one across tunnels would mean sharing its `upgrade` handler
   * too, which is where the per-tunnel hostname and port live. Noted rather
   * than optimised.
   */
  private serveH1Tunnel(tlsSocket: tls.TLSSocket, hostname: string, port: number): void {
    const virtualServer = http.createServer((clientReq, clientRes) => {
      const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
      this.dispatchExchange(clientReq, clientRes, target);
    });

    // wss:// arrives as an upgrade request inside the tunnel, so the virtual
    // server needs the same dispatch as the plain listener.
    virtualServer.on('upgrade', (clientReq, socket: net.Socket, upgradeHead: Buffer) => {
      const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
      handleWebSocketUpgrade(clientReq, socket, upgradeHead, target, this.webSocketDeps);
    });

    virtualServer.emit('connection', tlsSocket);
  }

  /**
   * The HTTP/2 half: the same throwaway-virtual-server trick, but using
   * `http2.createServer` — this socket's TLS is already terminated.
   *
   * Requests reach the shared pipeline through Node's compatibility API,
   * whose `Http2ServerRequest`/`Http2ServerResponse` satisfy
   * `ExchangeRequest`/`ExchangeResponse` structurally.
   *
   * Same per-CONNECT cost as {@link serveH1Tunnel}, and the same verdict: an h2
   * server per tunnel is acceptable for now, and it is at least amortised over
   * every stream multiplexed on the connection rather than over one request.
   *
   * **WebSockets over h2 (RFC 8441) are deliberately not supported**, and both
   * ways a client can ask for them fail cleanly rather than hanging. Extended
   * CONNECT requires the server to advertise `SETTINGS_ENABLE_CONNECT_PROTOCOL`,
   * which `http2.createServer` does not by default, so a `:protocol` stream is
   * rejected with `RST_STREAM(PROTOCOL_ERROR)`. A plain `CONNECT` stream is
   * answered `405 Method Not Allowed` by the compatibility layer, precisely
   * because no `connect` listener is registered below — its absence is load
   * bearing. (An `Upgrade` header never gets that far: HTTP/2 forbids it, and a
   * client's own `session.request` throws on it.) The `Upgrade`-based capture in
   * {@link serveH1Tunnel} is untouched and still the way wss:// is recorded.
   */
  private serveH2Tunnel(tlsSocket: tls.TLSSocket, hostname: string, port: number): void {
    // See `markHandshakeComplete`: if the field it pokes disappears, fail loudly
    // here rather than leave a session that never starts and never errors.
    if (!markHandshakeComplete(tlsSocket)) {
      tlsSocket.destroy(
        new Error(
          'cannot start an HTTP/2 session on this tunnel: TLSSocket has no ' +
            'secureConnecting field (Node internals changed)',
        ),
      );
      return;
    }

    const virtualServer = http2.createServer();
    virtualServer.on('request', (clientReq, clientRes) => {
      const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
      this.dispatchExchange(clientReq, clientRes, target, 'h2');
    });

    // Both listeners exist so a session failure can't surface as an unhandled
    // 'error' event, which would crash the process.
    virtualServer.on('sessionError', () => tlsSocket.destroy());
    virtualServer.on('error', () => tlsSocket.destroy());

    virtualServer.emit('connection', tlsSocket);
  }
}
