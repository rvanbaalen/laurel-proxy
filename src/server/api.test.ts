import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { createApiRouter } from './api.js';
import { Database } from '../storage/db.js';
import { EventManager } from './events.js';
import { Throttler } from './throttle.js';
import { getConfigPath } from './config.js';
import type { RequestRecord } from '../shared/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://example.com/test',
    host: 'example.com',
    path: '/test',
    protocol: 'http' as const,
    request_headers: '{"host":"example.com"}',
    request_body: null,
    request_size: 0,
    status: 200,
    response_headers: '{"content-type":"text/html"}',
    response_body: Buffer.from('hello'),
    response_size: 5,
    duration: 100,
    content_type: 'text/html',
    truncated: 0,
    ...overrides,
  };
}

function httpReq(
  port: number,
  reqPath: string,
  method = 'GET',
  jsonBody?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
    const headers = payload !== undefined
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : undefined;
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('REST API', () => {
  let db: Database;
  let dbPath: string;
  let events: EventManager;
  let throttler: Throttler;
  let server: http.Server;
  let port: number;
  let configDir: string;
  let originalConfigEnv: string | undefined;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `laurel-proxy-api-test-${randomUUID()}.db`);
    db = new Database(dbPath);
    events = new EventManager();
    throttler = new Throttler();

    // Redirect config I/O to a throwaway temp file so PUT /api/throttle's
    // saveThrottleSettings() call never touches the developer's real
    // ~/.laurel-proxy/config.json.
    originalConfigEnv = process.env.LAUREL_PROXY_CONFIG;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-proxy-api-test-config-'));
    process.env.LAUREL_PROXY_CONFIG = path.join(configDir, 'config.json');

    const app = express();
    app.use(express.json());
    const router = createApiRouter(db, events, {
      getProxyRunning: () => true,
      getProxyPort: () => 8080,
      startProxy: async () => {},
      stopProxy: async () => {},
    }, undefined, throttler);
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
    events.stop();
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}

    if (originalConfigEnv === undefined) delete process.env.LAUREL_PROXY_CONFIG;
    else process.env.LAUREL_PROXY_CONFIG = originalConfigEnv;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('GET /api/requests returns paginated list', async () => {
    db.insert(makeRequest());
    db.insert(makeRequest());
    const res = await httpReq(port, '/api/requests');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  });

  it('GET /api/requests filters by host', async () => {
    db.insert(makeRequest({ host: 'api.example.com' }));
    db.insert(makeRequest({ host: 'cdn.other.com' }));
    const res = await httpReq(port, '/api/requests?host=example');
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].host).toBe('api.example.com');
  });

  it('GET /api/requests/:id returns single request', async () => {
    const req = makeRequest();
    db.insert(req);
    const res = await httpReq(port, `/api/requests/${req.id}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(req.id);
  });

  it('GET /api/requests/:id returns 404 for unknown id', async () => {
    const res = await httpReq(port, '/api/requests/nonexistent');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/requests clears all', async () => {
    db.insert(makeRequest());
    const res = await httpReq(port, '/api/requests', 'DELETE');
    expect(res.status).toBe(200);
    expect(db.getRequestCount()).toBe(0);
  });

  it('GET /api/status returns proxy status', async () => {
    const res = await httpReq(port, '/api/status');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.running).toBe(true);
    expect(body.proxyPort).toBe(8080);
  });

  it('GET /api/throttle returns current settings and presets', async () => {
    const res = await httpReq(port, '/api/throttle');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.settings.enabled).toBe(false);
    expect(body.presets['3g']).toEqual({ downKbps: 780, upKbps: 330, latencyMs: 100 });
  });

  it('PUT /api/throttle applies a named preset', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: '3g' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.settings).toEqual({
      enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100,
    });
    expect(throttler.getSettings()).toEqual(body.settings);
  });

  it('PUT /api/throttle applies custom values', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', {
      enabled: true, downKbps: 500, upKbps: 250, latencyMs: 50,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.settings.downKbps).toBe(500);
  });

  it('PUT /api/throttle rejects an unknown preset, and lists "off" as valid', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: 'carrier-pigeon' });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Unknown preset');
    expect(body.error).toContain('off');
  });

  it('PUT /api/throttle rejects a negative rate', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', { enabled: true, downKbps: -5 });
    expect(res.status).toBe(400);
  });

  it('PUT /api/throttle rejects a non-finite rate (NaN via bad JSON number would fail to parse, so test object/array instead)', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', { enabled: true, downKbps: { not: 'a number' } });
    expect(res.status).toBe(400);
  });

  it('PUT /api/throttle rejects a non-boolean enabled value', async () => {
    // "false" (a truthy, non-empty string) must not silently enable throttling.
    const res = await httpReq(port, '/api/throttle', 'PUT', { enabled: 'false', downKbps: 100 });
    expect(res.status).toBe(400);
    expect(throttler.getSettings().enabled).toBe(false);
  });

  it('preset "off" genuinely disables rather than merely zeroing rates', async () => {
    await httpReq(port, '/api/throttle', 'PUT', { preset: '4g' });
    expect(throttler.getSettings().enabled).toBe(true);

    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: 'off' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.settings.enabled).toBe(false);
    expect(throttler.getSettings().enabled).toBe(false);
    // The underlying rate limiters must actually be unthrottled, not just
    // flagged disabled while carrying stale nonzero rates.
    expect(throttler.getSettings().downKbps).toBe(0);
  });

  it('a preset takes precedence over explicit rate fields in the same body', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', {
      preset: '3g', downKbps: 999, upKbps: 999, latencyMs: 999,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.settings).toEqual({
      enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100,
    });
  });

  it('a rejected PUT leaves the live throttler settings untouched', async () => {
    await httpReq(port, '/api/throttle', 'PUT', { preset: '3g' });
    const before = throttler.getSettings();

    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: 'carrier-pigeon' });
    expect(res.status).toBe(400);
    expect(throttler.getSettings()).toEqual(before);
  });

  it('a rejected PUT does not write the config file', async () => {
    const configPath = getConfigPath();
    expect(fs.existsSync(configPath)).toBe(false);

    const res = await httpReq(port, '/api/throttle', 'PUT', { enabled: true, downKbps: -5 });
    expect(res.status).toBe(400);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('a preset with an explicit null applies the preset, not the explicit-merge branch', async () => {
    // `preset: null` must be treated as "no preset", not as an attempted
    // (and doomed) lookup of the literal preset "null".
    const res = await httpReq(port, '/api/throttle', 'PUT', {
      preset: null, enabled: true, downKbps: 500, upKbps: 250, latencyMs: 50,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.settings.downKbps).toBe(500);
  });

  it('PUT /api/throttle returns 5xx and leaves live settings unchanged when persistence fails', async () => {
    const before = throttler.getSettings();

    // Point the config path at a location whose parent path segment already
    // exists as a regular file. fs.mkdirSync(dirname, { recursive: true })
    // inside saveThrottleSettings then reliably throws (EEXIST on macOS,
    // ENOTDIR on Linux) — no root privileges or chmod tricks required, and
    // it behaves the same on both platforms.
    const blocker = path.join(configDir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    process.env.LAUREL_PROXY_CONFIG = path.join(blocker, 'config.json');

    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: '3g' });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/persist/i);
    // This is the assertion that proves the ordering: the live throttler
    // must not have been mutated when the persist step failed.
    expect(throttler.getSettings()).toEqual(before);
  });

  it('PUT /api/throttle persists settings to the redirected config file', async () => {
    const configPath = getConfigPath();
    expect(configPath.startsWith(configDir)).toBe(true);

    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: 'dsl' });
    expect(res.status).toBe(200);

    expect(fs.existsSync(configPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(saved.throttle).toEqual({
      enabled: true, downKbps: 2000, upKbps: 256, latencyMs: 40,
    });
  });
});

describe('REST API throttle endpoints without a throttler wired', () => {
  let db: Database;
  let dbPath: string;
  let events: EventManager;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `laurel-proxy-api-test-${randomUUID()}.db`);
    db = new Database(dbPath);
    events = new EventManager();
    const app = express();
    app.use(express.json());
    // No `ca` (4th arg) and no `throttler` (5th arg): throttle routes must
    // degrade gracefully instead of throwing.
    const router = createApiRouter(db, events, {
      getProxyRunning: () => true,
      getProxyPort: () => 8080,
      startProxy: async () => {},
      stopProxy: async () => {},
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
    events.stop();
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('GET /api/throttle returns 503 when no throttler is wired', async () => {
    const res = await httpReq(port, '/api/throttle');
    expect(res.status).toBe(503);
  });

  it('PUT /api/throttle returns 503 when no throttler is wired', async () => {
    const res = await httpReq(port, '/api/throttle', 'PUT', { preset: '3g' });
    expect(res.status).toBe(503);
  });
});
