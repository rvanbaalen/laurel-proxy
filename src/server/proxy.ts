import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { Database } from '../storage/db.js';
import type { CertificateAuthority } from './ssl.js';
import type { EventManager } from './events.js';
import type { Config, RequestRecord, WebSocketMessage } from '../shared/types.js';
import { listenWithRetry } from './port-utils.js';
import { recordSafely } from '../shared/recording-safety.js';
import { handleExchange, resolveHttpTarget, resolveMitmTarget } from './exchange.js';
import type { ExchangeDeps } from './exchange.js';
import { handleWebSocketUpgrade } from './websocket.js';
import type { WebSocketDeps } from './websocket.js';
import type { Throttler } from './throttle.js';

export class ProxyServer {
  private server: http.Server | null = null;
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
   * queued before any of its frames, so draining in this order means a reader
   * can never find a frame whose parent row has not landed yet.
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
   * failure into a permanent one. The two queues are guarded separately so a
   * failing request insert does not also cost the frames.
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

  private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const target = resolveHttpTarget(clientReq.url || '/');
    if (!target) {
      clientRes.writeHead(400);
      clientRes.end('Bad Request');
      return;
    }
    void handleExchange(clientReq, clientRes, target, this.exchangeDeps);
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
        ALPNProtocols: ['http/1.1'],
      });

      tlsSocket.on('error', () => {
        clientSocket.destroy();
      });

      const virtualServer = http.createServer((clientReq, clientRes) => {
        const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
        void handleExchange(clientReq, clientRes, target, this.exchangeDeps);
      });

      // wss:// arrives as an upgrade request inside the tunnel, so the virtual
      // server needs the same dispatch as the plain listener.
      virtualServer.on('upgrade', (clientReq, socket: net.Socket, upgradeHead: Buffer) => {
        const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
        handleWebSocketUpgrade(clientReq, socket, upgradeHead, target, this.webSocketDeps);
      });

      virtualServer.emit('connection', tlsSocket);
    } catch {
      clientSocket.end();
    }
  }
}
