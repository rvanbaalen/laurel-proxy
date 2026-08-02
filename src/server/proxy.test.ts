import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { ProxyServer } from './proxy.js';
import { Database } from '../storage/db.js';
import { CertificateAuthority } from './ssl.js';
import { EventManager } from './events.js';
import { DEFAULT_CONFIG } from '../shared/types.js';
import type { Config, RequestRecord, WebSocketMessage } from '../shared/types.js';
import { startRawWsServer, echoHandler } from '../../tests/helpers/ws-server.js';
import { encodeFrame } from '../../tests/helpers/ws-frames.js';
import { watchProcessErrors } from '../../tests/helpers/process-errors.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto, { randomUUID } from 'node:crypto';

function createTargetServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'hello' }));
      } else if (req.url === '/echo') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(body);
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function httpGet(url: string, proxyPort: number): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(url);
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: url,
      headers: { Host: proxyUrl.hostname },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ProxyServer - HTTP', () => {
  let targetServer: http.Server;
  let targetPort: number;
  let proxy: ProxyServer;
  let db: Database;
  let events: EventManager;
  let dbPath: string;
  let caDir: string;
  let proxyPort: number;

  beforeAll(async () => {
    targetServer = await createTargetServer();
    targetPort = (targetServer.address() as net.AddressInfo).port;
  });

  afterAll(() => {
    targetServer.close();
  });

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `laurel-proxy-test-${randomUUID()}.db`);
    caDir = path.join(os.tmpdir(), `laurel-proxy-ca-test-${randomUUID()}`);
    db = new Database(dbPath);
    events = new EventManager();
    const ca = new CertificateAuthority(caDir, 10);
    ca.init();
    const config: Config = {
      ...DEFAULT_CONFIG,
      proxyPort: 0,
      dbPath,
      maxBodySize: 1024 * 1024,
    };
    proxy = new ProxyServer(db, ca, events, config);
    proxyPort = await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    events.stop();
    db.close();
    fs.rmSync(caDir, { recursive: true, force: true });
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('proxies HTTP GET and captures the request', async () => {
    const url = `http://127.0.0.1:${targetPort}/json`;
    const res = await httpGet(url, proxyPort);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ message: 'hello' });

    await new Promise(r => setTimeout(r, 200));
    const count = db.getRequestCount();
    expect(count).toBe(1);

    const result = db.query({});
    expect(result.data[0].method).toBe('GET');
    expect(result.data[0].status).toBe(200);
  });

  it('captures request body on POST', async () => {
    const url = `http://127.0.0.1:${targetPort}/echo`;
    const postBody = 'test body content';

    await new Promise<void>((resolve, reject) => {
      const proxyUrl = new URL(url);
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'POST',
        path: url,
        headers: {
          Host: proxyUrl.hostname,
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(postBody).toString(),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          expect(res.statusCode).toBe(200);
          expect(body).toBe(postBody);
          resolve();
        });
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });

    await new Promise(r => setTimeout(r, 200));
    const result = db.query({});
    expect(result.data[0].method).toBe('POST');
    expect(result.data[0].request_size).toBe(Buffer.byteLength(postBody));
  });
});

function createHttpsTargetServer(certPem: string, keyPem: string): Promise<https.Server> {
  return new Promise((resolve) => {
    const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
      if (req.url === '/secure-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secure: true }));
      } else if (req.url === '/secure-echo') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(body);
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('secure-ok');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

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
      const tlsSocket = tls.connect({
        socket: socket as net.Socket,
        host: targetHost,
        ca: caCertPem,
        servername: targetHost,
      }, () => {
        resolve(tlsSocket);
      });

      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

function httpsGetThroughTunnel(
  tlsSocket: tls.TLSSocket,
  hostname: string,
  urlPath: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      createConnection: () => tlsSocket as unknown as net.Socket,
      hostname,
      path: urlPath,
      method: 'GET',
      headers: { Host: hostname },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ProxyServer - HTTPS', () => {
  let targetServer: https.Server;
  let targetPort: number;
  let proxy: ProxyServer;
  let db: Database;
  let events: EventManager;
  let dbPath: string;
  let caDir: string;
  let ca: CertificateAuthority;
  let proxyPort: number;
  let caCertPem: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `laurel-proxy-test-${randomUUID()}.db`);
    caDir = path.join(os.tmpdir(), `laurel-proxy-ca-test-${randomUUID()}`);
    db = new Database(dbPath);
    events = new EventManager();
    ca = new CertificateAuthority(caDir, 10);
    ca.init();

    caCertPem = fs.readFileSync(ca.getCaCertPath(), 'utf-8');

    // Create an HTTPS target server using a cert signed by this CA for localhost
    const targetCert = ca.getCertForHost('localhost');
    targetServer = await createHttpsTargetServer(targetCert.cert, targetCert.key);
    targetPort = (targetServer.address() as net.AddressInfo).port;

    const config: Config = {
      ...DEFAULT_CONFIG,
      proxyPort: 0,
      dbPath,
      maxBodySize: 1024 * 1024,
    };
    proxy = new ProxyServer(db, ca, events, config);
    proxyPort = await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    events.stop();
    db.close();
    targetServer.close();
    fs.rmSync(caDir, { recursive: true, force: true });
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('captures HTTPS request via CONNECT tunnel', async () => {
    // Connect through the proxy using CONNECT method
    const tlsSocket = await connectThroughProxy(proxyPort, 'localhost', targetPort, caCertPem);

    // Send a GET request through the TLS tunnel
    const res = await httpsGetThroughTunnel(tlsSocket, 'localhost', '/secure-json');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ secure: true });

    tlsSocket.destroy();

    // Wait for the proxy to flush writes
    await new Promise(r => setTimeout(r, 300));

    const count = db.getRequestCount();
    expect(count).toBe(1);

    const result = db.query({});
    expect(result.data[0].method).toBe('GET');
    expect(result.data[0].protocol).toBe('https');
    // The recorded URL carries the tunnelled port, so a replay of this capture
    // targets the server it came from rather than 443.
    expect(result.data[0].url).toBe(`https://localhost:${targetPort}/secure-json`);
    expect(result.data[0].status).toBe(200);
  });

  it('retains the query string in the recorded path for HTTPS requests', async () => {
    const tlsSocket = await connectThroughProxy(proxyPort, 'localhost', targetPort, caCertPem);

    const res = await httpsGetThroughTunnel(tlsSocket, 'localhost', '/secure-json?foo=bar&baz=2');

    expect(res.status).toBe(200);

    tlsSocket.destroy();

    await new Promise(r => setTimeout(r, 300));

    const result = db.query({});
    expect(result.data[0].url).toBe(`https://localhost:${targetPort}/secure-json?foo=bar&baz=2`);
    // Regression: the recorded path must keep the query string, not just the
    // pathname — a re-derivation from the URL previously dropped it.
    expect(result.data[0].path).toBe('/secure-json?foo=bar&baz=2');
  });

  it('captures HTTPS POST request body via CONNECT tunnel', async () => {
    const tlsSocket = await connectThroughProxy(proxyPort, 'localhost', targetPort, caCertPem);
    const postBody = 'secure post body';

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        createConnection: () => tlsSocket as unknown as net.Socket,
        hostname: 'localhost',
        path: '/secure-echo',
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(postBody).toString(),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe(postBody);

    tlsSocket.destroy();

    await new Promise(r => setTimeout(r, 300));

    const result = db.query({});
    expect(result.data[0].method).toBe('POST');
    expect(result.data[0].protocol).toBe('https');
    expect(result.data[0].request_size).toBe(Buffer.byteLength(postBody));
  });

  it('returns 200 Connection Established for CONNECT requests', async () => {
    const connectResult = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: 'localhost:443',
      });

      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve({ statusCode: res.statusCode! });
      });

      req.on('error', reject);
      req.end();
    });

    expect(connectResult.statusCode).toBe(200);
  });
});

/**
 * A Database that accepts nothing.
 *
 * `ProxyServer` only ever reaches `insertBatch` and `insertWebSocketMessages`,
 * so a two-method stand-in covers it. A stub rather than a real database is what
 * makes the failure deterministic: the real one throws from exactly here on a
 * full disk (`SQLITE_FULL`), a locked file, a corrupted database or a failed
 * migration, and none of those can be arranged reliably inside a test.
 */
function createFullDiskDb(): {
  db: Database;
  requestBatches: RequestRecord[][];
  messageBatches: WebSocketMessage[][];
} {
  const requestBatches: RequestRecord[][] = [];
  const messageBatches: WebSocketMessage[][] = [];
  const db = {
    insertBatch(records: RequestRecord[]): void {
      requestBatches.push(records);
      throw new Error('SQLITE_FULL: database or disk is full');
    },
    insertWebSocketMessages(messages: WebSocketMessage[]): void {
      messageBatches.push(messages);
      throw new Error('SQLITE_FULL: database or disk is full');
    },
  };
  return { db: db as unknown as Database, requestBatches, messageBatches };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The flush timer is the one recording path a user reaches without doing
 * anything unusual — a full disk is enough — and it runs from `setInterval`,
 * where an escaping throw is an uncaught exception and therefore the end of the
 * developer's proxy. Losing rows is the acceptable failure; dying is not.
 */
describe('ProxyServer - recording failures', () => {
  let targetServer: http.Server;
  let targetPort: number;
  let proxy: ProxyServer;
  let events: EventManager;
  let caDir: string;
  let proxyPort: number;
  let failing: ReturnType<typeof createFullDiskDb>;

  beforeEach(async () => {
    targetServer = await createTargetServer();
    targetPort = (targetServer.address() as net.AddressInfo).port;
    caDir = path.join(os.tmpdir(), `laurel-proxy-ca-test-${randomUUID()}`);
    events = new EventManager();
    const ca = new CertificateAuthority(caDir, 10);
    ca.init();
    failing = createFullDiskDb();
    const config: Config = {
      ...DEFAULT_CONFIG,
      proxyPort: 0,
      dbPath: path.join(os.tmpdir(), `laurel-proxy-unused-${randomUUID()}.db`),
      maxBodySize: 1024 * 1024,
    };
    proxy = new ProxyServer(failing.db, ca, events, config);
    proxyPort = await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    events.stop();
    targetServer.close();
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('keeps proxying when the request insert throws, and drops the batch', async () => {
    const first = `http://127.0.0.1:${targetPort}/json`;
    const second = `http://127.0.0.1:${targetPort}/`;
    let firstRes: Awaited<ReturnType<typeof httpGet>> | undefined;
    let secondRes: Awaited<ReturnType<typeof httpGet>> | undefined;

    const escaped = await watchProcessErrors(async () => {
      firstRes = await httpGet(first, proxyPort);
      // Two turns of the 100ms flush timer, so the failing insert has certainly
      // run — and the timer has certainly fired again — before the next request.
      await sleep(250);
      secondRes = await httpGet(second, proxyPort);
      await sleep(250);
    });

    // The proxy is still alive and still answering, and the bytes are intact.
    expect(escaped).toEqual([]);
    expect(firstRes?.status).toBe(200);
    expect(JSON.parse(firstRes!.body)).toEqual({ message: 'hello' });
    expect(secondRes?.status).toBe(200);
    expect(secondRes?.body).toBe('ok');

    // Exactly one insert attempt per request, in order. Anything appearing
    // twice would mean the failed batch went back on the queue, which would
    // grow it without bound and turn a full disk into a permanent failure.
    expect(failing.requestBatches.flat().map((r) => r.url)).toEqual([first, second]);
  });

  it('keeps relaying frames when the message insert throws, and drops the batch', async () => {
    const upstream = await startRawWsServer({ onMessage: echoHandler });
    const echoFrame = encodeFrame('text', Buffer.from('re:hello'));
    let relayed = Buffer.alloc(0);

    try {
      const escaped = await watchProcessErrors(async () => {
        await new Promise<void>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port: proxyPort,
            path: `http://127.0.0.1:${upstream.port}/ws`,
            headers: {
              host: `127.0.0.1:${upstream.port}`,
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
              'Sec-WebSocket-Version': '13',
            },
          });
          req.on('upgrade', (_res, socket, head) => {
            relayed = Buffer.concat([relayed, head]);
            socket.on('data', (chunk: Buffer) => {
              relayed = Buffer.concat([relayed, chunk]);
              if (relayed.length >= echoFrame.length) {
                socket.end();
                resolve();
              }
            });
            socket.on('error', reject);
            socket.write(encodeFrame('text', Buffer.from('hello'), true));
          });
          req.on('error', reject);
          req.end();
        });
        await sleep(300);
      });

      expect(escaped).toEqual([]);
      // Byte-identical: the relay owes the application every byte even when
      // every write to the database is failing.
      expect(relayed.equals(echoFrame)).toBe(true);

      const offered = failing.messageBatches.flat();
      expect(
        offered.map((m) => `${m.direction}:${Buffer.from(m.payload!).toString()}`),
      ).toEqual(['sent:hello', 'received:re:hello']);
      // Same drop-don't-retry rule as the request queue.
      expect(new Set(offered.map((m) => m.id)).size).toBe(offered.length);
    } finally {
      upstream.close();
    }
  });
});

describe('CertificateAuthority', () => {
  let caDir: string;
  let ca: CertificateAuthority;

  beforeEach(() => {
    caDir = path.join(os.tmpdir(), `laurel-proxy-ca-unit-${randomUUID()}`);
    ca = new CertificateAuthority(caDir, 10);
    ca.init();
  });

  afterEach(() => {
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('creates CA certificate and key files on init', () => {
    expect(fs.existsSync(path.join(caDir, 'ca.crt'))).toBe(true);
    expect(fs.existsSync(path.join(caDir, 'ca.key'))).toBe(true);
  });

  it('generates a domain cert signed by the CA', () => {
    const pair = ca.getCertForHost('example.com');
    expect(pair.cert).toContain('BEGIN CERTIFICATE');
    expect(pair.key).toContain('BEGIN RSA PRIVATE KEY');

    // Verify the cert can be loaded and has the right CN
    const forge = require('node-forge');
    const cert = forge.pki.certificateFromPem(pair.cert);
    const cn = cert.subject.getField('CN');
    expect(cn.value).toBe('example.com');

    // Verify it's signed by our CA
    const caCertPem = fs.readFileSync(ca.getCaCertPath(), 'utf-8');
    const caCert = forge.pki.certificateFromPem(caCertPem);
    expect(caCert.verify(cert)).toBe(true);
  });

  it('caches certificates for the same hostname', () => {
    const pair1 = ca.getCertForHost('cached.example.com');
    const pair2 = ca.getCertForHost('cached.example.com');
    expect(pair1.cert).toBe(pair2.cert);
    expect(pair1.key).toBe(pair2.key);
  });

  it('generates different certificates for different hostnames', () => {
    const pair1 = ca.getCertForHost('host1.example.com');
    const pair2 = ca.getCertForHost('host2.example.com');
    expect(pair1.cert).not.toBe(pair2.cert);
    expect(pair1.key).not.toBe(pair2.key);
  });

  it('reloads existing CA from disk on re-init', () => {
    const caCertPem1 = fs.readFileSync(ca.getCaCertPath(), 'utf-8');

    const ca2 = new CertificateAuthority(caDir, 10);
    ca2.init();
    const caCertPem2 = fs.readFileSync(ca2.getCaCertPath(), 'utf-8');

    expect(caCertPem1).toBe(caCertPem2);
  });
});
