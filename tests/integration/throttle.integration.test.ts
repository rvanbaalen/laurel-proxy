import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { LaurelProxyServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';

describe('bandwidth throttling', () => {
  let server: LaurelProxyServer;
  let upstream: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-throttle-'));
    // 20 KiB body: at 80 kbps (10_000 B/s) this takes ~2s, fast enough to keep
    // the test quick while still being an unambiguous signal above noise.
    const body = Buffer.alloc(20_000, 'x');
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
    });
    await new Promise<void>((r) => upstream.listen(0, r));
    upstreamPort = (upstream.address() as net.AddressInfo).port;

    const config = loadConfig({
      dbPath: path.join(tmpDir, 'data.db'),
      proxyPort: 0,
      uiPort: 0,
    });
    server = new LaurelProxyServer(config);
    const ports = await server.start();
    proxyPort = ports.proxyPort;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    upstream.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function proxiedGet(url: string): Promise<{ status: number; length: number }> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: url,
          headers: { host: target.host },
        },
        (res) => {
          let length = 0;
          res.on('data', (c: Buffer) => { length += c.length; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, length }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('transfers at full speed when throttling is disabled', async () => {
    server.throttler.update({ enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 });
    const started = Date.now();
    const res = await proxiedGet(`http://127.0.0.1:${upstreamPort}/big`);
    expect(res.status).toBe(200);
    expect(res.length).toBe(20_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('paces the response to the configured downstream rate', async () => {
    // 80 kbps = 10_000 B/s, so 20_000 bytes needs ~2s. Lower bound given a
    // generous margin (1500ms) to tolerate scheduler jitter on loaded CI boxes.
    server.throttler.update({ enabled: true, downKbps: 80, upKbps: 80, latencyMs: 0 });
    const started = Date.now();
    const res = await proxiedGet(`http://127.0.0.1:${upstreamPort}/big`);
    const elapsed = Date.now() - started;
    expect(res.length).toBe(20_000);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    server.throttler.update({ enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 });
  }, 20_000);

  it('injects latency before the first response byte', async () => {
    server.throttler.update({ enabled: true, downKbps: 0, upKbps: 0, latencyMs: 700 });
    const started = Date.now();
    await proxiedGet(`http://127.0.0.1:${upstreamPort}/big`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    server.throttler.update({ enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 });
  }, 20_000);
});
