import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { ProxyServer } from './proxy.js';
import { Database } from '../storage/db.js';
import { CertificateAuthority } from './ssl.js';
import { EventManager } from './events.js';
import { DEFAULT_CONFIG } from '../shared/types.js';
import type { Config } from '../shared/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

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
    dbPath = path.join(os.tmpdir(), `roxyproxy-test-${randomUUID()}.db`);
    caDir = path.join(os.tmpdir(), `roxyproxy-ca-test-${randomUUID()}`);
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
