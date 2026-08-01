import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { Database } from '../storage/db.js';
import type { CertificateAuthority } from './ssl.js';
import type { EventManager } from './events.js';
import type { Config, RequestRecord } from '../shared/types.js';
import { listenWithRetry } from './port-utils.js';
import { handleExchange, resolveHttpTarget, resolveMitmTarget } from './exchange.js';
import type { ExchangeDeps } from './exchange.js';

export class ProxyServer {
  private server: http.Server | null = null;
  private sockets: Set<net.Socket> = new Set();
  private writeQueue: RequestRecord[] = [];
  private writeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private ca: CertificateAuthority,
    private events: EventManager,
    private config: Config,
  ) {}

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('connect', (req, clientSocket: net.Socket, head) => this.handleConnect(req, clientSocket, head));
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

  private flushWrites(): void {
    if (this.writeQueue.length === 0) return;
    const batch = this.writeQueue;
    this.writeQueue = [];
    this.db.insertBatch(batch);
  }

  private get exchangeDeps(): ExchangeDeps {
    return {
      config: this.config,
      onRecord: (record) => {
        this.writeQueue.push(record);
        this.events.push(record);
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

      virtualServer.emit('connection', tlsSocket);
    } catch {
      clientSocket.end();
    }
  }
}
