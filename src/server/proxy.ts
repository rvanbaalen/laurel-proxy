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

export class ProxyServer {
  private server: http.Server | null = null;
  /**
   * Owned here rather than per exchange because it is a cache and a connection
   * pool: an h2 session is worth reusing across requests to the same origin, and
   * an ALPN verdict is worth remembering. Its lifetime therefore has to match the
   * server's, which is why it is created in `start` and closed in `stop` like
   * `server` and `sockets` — an unclosed pool holds sockets, and this process is
   * a CLI that has to be able to exit.
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
    // Before the client sockets, and unconditionally: pooled h2 sessions are
    // upstream sockets nothing else in this class knows about, and leaving them
    // open keeps the event loop alive after `stop()` resolves.
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
   * Requests are flushed before frames: a WebSocket connection's row is always
   * queued before any of its frames, so **as long as the request insert
   * succeeds**, draining in this order means a reader can never find a frame
   * whose parent row has not landed yet.
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
        // Offer both and let the client pick. ALPN is the mechanism HTTP/2
        // defines for exactly this question, so there is no flag and no user
        // decision here. What the *origin* speaks is negotiated separately and
        // independently — see `upstream.ts`.
        ALPNProtocols: ['h2', 'http/1.1'],
      });

      tlsSocket.on('error', () => {
        clientSocket.destroy();
      });

      // `secure`, not `secureConnect`: the latter belongs to sockets created by
      // `tls.connect`. A server-side `TLSSocket` announces a completed handshake
      // as `secure`, and the handshake is the earliest moment `alpnProtocol` has
      // a value — which is why the virtual server is now built here rather than
      // immediately. Nothing is lost by waiting: the socket has no reader until
      // one of the branches below attaches one, so any application bytes that
      // arrive first sit in its readable buffer.
      tlsSocket.once('secure', () => {
        // Only the exact string means h2. `alpnProtocol` is `false` when the
        // client offered no ALPN at all (measured on Node 22.21.1; the typings
        // also allow `null`/`undefined`), and every one of those is an HTTP/1.1
        // client — never an h2 one, and never a crash.
        if (tlsSocket.alpnProtocol === 'h2') this.serveH2Tunnel(tlsSocket, hostname, port);
        else this.serveH1Tunnel(tlsSocket, hostname, port);
      });
    } catch {
      clientSocket.end();
    }
  }

  /**
   * The HTTP/1.1 half of a MITM tunnel, unchanged from before ALPN offered a
   * choice: a throwaway `http.Server` that is never listening, fed the decrypted
   * socket through `emit('connection')`.
   *
   * One server per CONNECT is wasteful — it is a fresh object graph per tunnel —
   * but it is what shipped and it works, and sharing one across tunnels would
   * mean sharing its `upgrade` handler too, which is where the per-tunnel
   * hostname and port live. Noted rather than optimised.
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
   * The HTTP/2 half: the same throwaway-virtual-server trick, with
   * `http2.createServer` rather than `http2.createSecureServer` because this
   * socket's TLS is already terminated. Requests reach the shared pipeline
   * through Node's compatibility API, whose `Http2ServerRequest`/
   * `Http2ServerResponse` satisfy `ExchangeRequest`/`ExchangeResponse`
   * structurally — that is what Task 2's seam bought.
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
    // `Http2Session` will not set up its handle while it believes TLS is still in
    // progress, and what it then waits for is `secureConnect` — an event a
    // server-side socket never emits. `secureConnecting` is left `true` forever on
    // a hand-built server `TLSSocket`: `tls.Server` is what normally clears it,
    // in `onServerSocketSecure`, just before handing the finished socket to its
    // `secureConnection` listeners. We are standing in for that listener, so we
    // have to stand in for that line too. Measured on Node 22.21.1 — without it
    // the session never starts and every request on the tunnel hangs forever,
    // with no error anywhere.
    (tlsSocket as unknown as { secureConnecting: boolean }).secureConnecting = false;

    const virtualServer = http2.createServer();
    virtualServer.on('request', (clientReq, clientRes) => {
      const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
      this.dispatchExchange(clientReq, clientRes, target, 'h2');
    });

    // A dead session is a dead tunnel; there is nothing to salvage and nothing to
    // tell the client, since the channel for telling it is what failed. Both
    // listeners exist mainly so a session-level failure cannot become an
    // unhandled 'error' event, which would end the process.
    virtualServer.on('sessionError', () => tlsSocket.destroy());
    virtualServer.on('error', () => tlsSocket.destroy());

    virtualServer.emit('connection', tlsSocket);
  }
}
