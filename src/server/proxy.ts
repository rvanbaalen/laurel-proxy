import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import zlib from 'node:zlib';
import type { Database } from '../storage/db.js';
import type { CertificateAuthority } from './ssl.js';
import type { EventManager } from './events.js';
import type { Config, RequestRecord } from '../shared/types.js';

export class ProxyServer {
  private server: http.Server | null = null;
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

    this.writeTimer = setInterval(() => this.flushWrites(), 100);

    return new Promise((resolve) => {
      this.server!.listen(this.config.proxyPort, () => {
        const addr = this.server!.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = null;
    }
    this.flushWrites();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
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

  private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const startTime = Date.now();
    const id = randomUUID();

    const url = clientReq.url || '/';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      clientRes.writeHead(400);
      clientRes.end('Bad Request');
      return;
    }

    const requestBodyChunks: Buffer[] = [];

    clientReq.on('data', (chunk: Buffer) => {
      requestBodyChunks.push(chunk);
    });

    clientReq.on('end', () => {
      const requestBody = Buffer.concat(requestBodyChunks);

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: clientReq.method,
        headers: { ...clientReq.headers },
      };
      delete (options.headers as Record<string, string>)['proxy-connection'];

      const proxyReq = http.request(options, (proxyRes) => {
        const responseBodyChunks: Buffer[] = [];

        proxyRes.on('data', (chunk: Buffer) => {
          responseBodyChunks.push(chunk);
        });

        proxyRes.on('end', () => {
          const rawResponseBody = Buffer.concat(responseBodyChunks);
          const responseBody = this.decodeBody(rawResponseBody, proxyRes.headers['content-encoding']);

          const headers = { ...proxyRes.headers };
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          headers['content-length'] = responseBody.length.toString();
          clientRes.writeHead(proxyRes.statusCode || 500, headers);
          clientRes.end(responseBody);

          const truncated = requestBody.length > this.config.maxBodySize || responseBody.length > this.config.maxBodySize;
          const contentType = (proxyRes.headers['content-type'] || '').split(';')[0].trim() || null;

          const record: RequestRecord = {
            id,
            timestamp: startTime,
            method: clientReq.method || 'GET',
            url,
            host: parsed.hostname || '',
            path: parsed.pathname || '/',
            protocol: 'http',
            request_headers: JSON.stringify(clientReq.headers),
            request_body: requestBody.length > 0 ? requestBody.slice(0, this.config.maxBodySize) : null,
            request_size: requestBody.length,
            status: proxyRes.statusCode || 0,
            response_headers: JSON.stringify(proxyRes.headers),
            response_body: responseBody.length > 0 ? responseBody.slice(0, this.config.maxBodySize) : null,
            response_size: responseBody.length,
            duration: Date.now() - startTime,
            content_type: contentType,
            truncated: truncated ? 1 : 0,
          };

          this.writeQueue.push(record);
          this.events.push(record);
        });
      });

      proxyReq.on('error', () => {
        clientRes.writeHead(502);
        clientRes.end('Bad Gateway');
      });

      if (requestBody.length > 0) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
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
      });

      const virtualServer = http.createServer((clientReq, clientRes) => {
        this.handleMitmRequest(hostname, port, clientReq, clientRes);
      });

      virtualServer.emit('connection', tlsSocket);
    } catch {
      clientSocket.end();
    }
  }

  private handleMitmRequest(hostname: string, port: number, clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const startTime = Date.now();
    const id = randomUUID();
    const urlPath = clientReq.url || '/';
    const fullUrl = `https://${hostname}${urlPath}`;

    const requestBodyChunks: Buffer[] = [];

    clientReq.on('data', (chunk: Buffer) => {
      requestBodyChunks.push(chunk);
    });

    clientReq.on('end', () => {
      const requestBody = Buffer.concat(requestBodyChunks);

      const options: https.RequestOptions = {
        hostname,
        port,
        path: urlPath,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: hostname },
        rejectUnauthorized: false,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        const responseBodyChunks: Buffer[] = [];

        proxyRes.on('data', (chunk: Buffer) => {
          responseBodyChunks.push(chunk);
        });

        proxyRes.on('end', () => {
          const rawResponseBody = Buffer.concat(responseBodyChunks);
          const responseBody = this.decodeBody(rawResponseBody, proxyRes.headers['content-encoding']);

          const headers = { ...proxyRes.headers };
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          headers['content-length'] = responseBody.length.toString();
          clientRes.writeHead(proxyRes.statusCode || 500, headers);
          clientRes.end(responseBody);

          const truncated = requestBody.length > this.config.maxBodySize || responseBody.length > this.config.maxBodySize;
          const contentType = (proxyRes.headers['content-type'] || '').split(';')[0].trim() || null;

          const record: RequestRecord = {
            id,
            timestamp: startTime,
            method: clientReq.method || 'GET',
            url: fullUrl,
            host: hostname,
            path: urlPath,
            protocol: 'https',
            request_headers: JSON.stringify(clientReq.headers),
            request_body: requestBody.length > 0 ? requestBody.slice(0, this.config.maxBodySize) : null,
            request_size: requestBody.length,
            status: proxyRes.statusCode || 0,
            response_headers: JSON.stringify(proxyRes.headers),
            response_body: responseBody.length > 0 ? responseBody.slice(0, this.config.maxBodySize) : null,
            response_size: responseBody.length,
            duration: Date.now() - startTime,
            content_type: contentType,
            truncated: truncated ? 1 : 0,
          };

          this.writeQueue.push(record);
          this.events.push(record);
        });
      });

      proxyReq.on('error', () => {
        clientRes.writeHead(502);
        clientRes.end('Bad Gateway');
      });

      if (requestBody.length > 0) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  }

  private decodeBody(body: Buffer, encoding?: string): Buffer {
    if (!encoding || !body.length) return body;
    try {
      switch (encoding) {
        case 'gzip': return zlib.gunzipSync(body);
        case 'deflate': return zlib.inflateSync(body);
        case 'br': return zlib.brotliDecompressSync(body);
        default: return body;
      }
    } catch {
      return body;
    }
  }
}
