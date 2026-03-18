import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { replay, recordToReplayRequest } from '../../src/server/replay.js';
import type { RequestRecord } from '../../src/shared/types.js';

describe('replay', () => {
  let targetServer: http.Server;
  let targetPort: number;

  beforeAll(async () => {
    targetServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: body || null,
        }));
      });
    });
    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(() => { targetServer.close(); });

  it('sends a GET request and returns the response', async () => {
    const result = await replay({
      url: `http://127.0.0.1:${targetPort}/test-path`,
      method: 'GET',
      headers: {},
    });
    expect(result.status).toBe(200);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.size).toBeGreaterThan(0);
    const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
    expect(body.method).toBe('GET');
    expect(body.path).toBe('/test-path');
  });

  it('sends a POST request with body', async () => {
    const payload = JSON.stringify({ hello: 'world' });
    const result = await replay({
      url: `http://127.0.0.1:${targetPort}/post-test`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(payload).toString('base64'),
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
    expect(body.method).toBe('POST');
    expect(body.body).toBe(payload);
  });

  it('strips accept-encoding header', async () => {
    const result = await replay({
      url: `http://127.0.0.1:${targetPort}/headers-test`,
      method: 'GET',
      headers: { 'accept-encoding': 'gzip', 'x-custom': 'test' },
    });
    const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
    expect(body.headers['accept-encoding']).toBeUndefined();
    expect(body.headers['x-custom']).toBe('test');
  });

  it('rejects invalid URL (no scheme)', async () => {
    await expect(replay({
      url: 'example.com/path',
      method: 'GET',
      headers: {},
    })).rejects.toThrow();
  });
});

describe('recordToReplayRequest', () => {
  it('converts a RequestRecord to ReplayRequest', () => {
    const record: RequestRecord = {
      id: 'test-id',
      timestamp: Date.now(),
      method: 'POST',
      url: 'https://example.com/api',
      host: 'example.com',
      path: '/api',
      protocol: 'https',
      request_headers: JSON.stringify({
        'content-type': 'application/json',
        'proxy-connection': 'keep-alive',
        'connection': 'keep-alive',
        'x-custom': 'value',
      }),
      request_body: Buffer.from('{"test":true}'),
      request_size: 13,
      status: 200,
      response_headers: null,
      response_body: null,
      response_size: 0,
      duration: 100,
      content_type: 'application/json',
      truncated: 0,
    };
    const result = recordToReplayRequest(record);
    expect(result.url).toBe('https://example.com/api');
    expect(result.method).toBe('POST');
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['x-custom']).toBe('value');
    expect(result.headers['proxy-connection']).toBeUndefined();
    expect(result.headers['connection']).toBeUndefined();
    expect(result.body).toBe(Buffer.from('{"test":true}').toString('base64'));
  });

  it('handles null body', () => {
    const record: RequestRecord = {
      id: 'test-id',
      timestamp: Date.now(),
      method: 'GET',
      url: 'http://example.com/',
      host: 'example.com',
      path: '/',
      protocol: 'http',
      request_headers: '{}',
      request_body: null,
      request_size: 0,
      status: 200,
      response_headers: null,
      response_body: null,
      response_size: 0,
      duration: 50,
      content_type: null,
      truncated: 0,
    };
    const result = recordToReplayRequest(record);
    expect(result.body).toBeUndefined();
  });
});

import { RoxyProxyServer } from '../../src/server/index.js';
import { DEFAULT_CONFIG } from '../../src/shared/types.js';
import type { Config } from '../../src/shared/types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('POST /api/replay', () => {
  let targetServer: http.Server;
  let targetPort: number;
  let proxy: RoxyProxyServer;
  let uiPort: number;
  let tmpDir: string;

  beforeAll(async () => {
    targetServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, path: req.url, body: body || null }));
      });
    });
    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    tmpDir = path.join(os.tmpdir(), `roxyproxy-replay-${randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const config: Config = { ...DEFAULT_CONFIG, proxyPort: 0, uiPort: 0, dbPath: path.join(tmpDir, 'data.db') };
    proxy = new RoxyProxyServer(config);
    const ports = await proxy.start();
    uiPort = ports.uiPort;
  });

  afterAll(async () => {
    await proxy.stop();
    targetServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replays a GET request via API', async () => {
    const reqBody = JSON.stringify({
      url: `http://127.0.0.1:${targetPort}/replay-test`,
      method: 'GET',
      headers: {},
    });

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: uiPort,
        path: '/api/replay',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.write(reqBody);
      req.end();
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe(200);
    expect(parsed.duration).toBeGreaterThanOrEqual(0);
    expect(parsed.size).toBeGreaterThan(0);
  });

  it('returns 400 for missing URL', async () => {
    const reqBody = JSON.stringify({ method: 'GET', headers: {} });

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: uiPort,
        path: '/api/replay',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.write(reqBody);
      req.end();
    });

    expect(res.status).toBe(400);
  });
});
