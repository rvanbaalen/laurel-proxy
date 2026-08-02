import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { createApiRouter } from './api.js';
import { Database } from '../storage/db.js';
import { EventManager } from './events.js';
import { Throttler } from './throttle.js';
import { getConfigPath } from './config.js';
import type { RequestRecord, WebSocketMessage } from '../shared/types.js';
import { startRawWsServer, echoHandler } from '../../tests/helpers/ws-server.js';
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

/**
 * Buffers a `text/event-stream` response and lets a test await a specific
 * `event:` block by name, regardless of how the underlying chunks happen to
 * split across `data` events. Frames already received before `waitFor` is
 * called are queued so ordering doesn't matter.
 */
function collectSse(res: http.IncomingMessage) {
  let buffer = '';
  const waiters: Array<{ event: string; resolve: (data: string) => void }> = [];
  const queued: Record<string, string[]> = {};

  res.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventMatch = raw.match(/^event: (.+)$/m);
      const dataMatch = raw.match(/^data: (.+)$/m);
      const event = eventMatch ? eventMatch[1] : 'message';
      const data = dataMatch ? dataMatch[1] : '';
      const waiterIndex = waiters.findIndex((w) => w.event === event);
      if (waiterIndex !== -1) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        waiter.resolve(data);
      } else {
        (queued[event] ??= []).push(data);
      }
    }
  });

  return {
    waitFor(event: string): Promise<string> {
      const already = queued[event]?.shift();
      if (already !== undefined) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ event, resolve }));
    },
  };
}

/** Spies on ws-message (un)subscription so a test can assert the SSE handler
 * actually cleans up its subscription on connection close, rather than just
 * asserting on side effects that would pass whether or not the leak exists. */
class SpyEventManager extends EventManager {
  wsSubscribeCalls = 0;
  wsUnsubscribeCalls = 0;

  subscribeWsMessages(fn: (messages: WebSocketMessage[]) => void): () => void {
    this.wsSubscribeCalls++;
    const unsub = super.subscribeWsMessages(fn);
    return () => {
      this.wsUnsubscribeCalls++;
      unsub();
    };
  }
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

  it('GET /api/requests filters by kind', async () => {
    db.insert(makeRequest({ host: 'plain.example.com' }));
    db.insert(makeRequest({ host: 'socket.example.com', kind: 'websocket', status: 101 }));

    const ws = JSON.parse((await httpReq(port, '/api/requests?kind=websocket')).body);
    expect(ws.total).toBe(1);
    expect(ws.data[0].host).toBe('socket.example.com');

    const http = JSON.parse((await httpReq(port, '/api/requests?kind=http')).body);
    expect(http.total).toBe(1);
    expect(http.data[0].host).toBe('plain.example.com');
  });

  it('GET /api/requests rejects an unknown kind rather than ignoring the filter', async () => {
    db.insert(makeRequest());
    // Silently dropping an unrecognised filter is the worse failure: the caller
    // asked for a subset and would get everything back, with nothing saying so.
    const res = await httpReq(port, '/api/requests?kind=webscoket');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/kind/i);
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

  it('GET /api/requests/:id/messages returns base64 payloads', async () => {
    db.insert(makeRequest({ id: 'ws-1', kind: 'websocket', status: 101 }));
    db.insertWebSocketMessages([
      { id: 'm1', request_id: 'ws-1', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('hello'), size: 5, truncated: 0 },
    ]);
    const res = await httpReq(port, '/api/requests/ws-1/messages');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.data[0].request_id).toBe('ws-1');
    expect(Buffer.from(body.data[0].payload, 'base64').toString()).toBe('hello');
  });

  it('GET /api/requests/:id/messages returns an empty page for unknown ids', async () => {
    // Deliberate: an unknown id is indistinguishable, from this endpoint's
    // point of view, from a known websocket request that hasn't received any
    // frames yet — both are "zero messages for this id". Mirrors how
    // `GET /api/requests?host=nomatch` returns `total: 0` rather than 404.
    const res = await httpReq(port, '/api/requests/nope/messages');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('GET /api/requests/:id/messages keeps a null payload null, not an empty string', async () => {
    db.insert(makeRequest({ id: 'ws-2', kind: 'websocket', status: 101 }));
    db.insertWebSocketMessages([
      { id: 'm2', request_id: 'ws-2', timestamp: 1, direction: 'received',
        opcode: 'close', payload: null, size: 0, truncated: 0 },
    ]);
    const res = await httpReq(port, '/api/requests/ws-2/messages');
    const body = JSON.parse(res.body);
    expect(body.data[0].payload).toBeNull();
  });

  it('GET /api/requests/:id/messages distinguishes a zero-length payload from an absent one', async () => {
    db.insert(makeRequest({ id: 'ws-3', kind: 'websocket', status: 101 }));
    db.insertWebSocketMessages([
      { id: 'm3', request_id: 'ws-3', timestamp: 1, direction: 'sent',
        opcode: 'ping', payload: Buffer.alloc(0), size: 0, truncated: 0 },
    ]);
    const res = await httpReq(port, '/api/requests/ws-3/messages');
    const body = JSON.parse(res.body);
    expect(body.data[0].payload).toBe('');
    expect(body.data[0].payload).not.toBeNull();
  });

  it('GET /api/requests/:id/messages rejects a non-numeric limit instead of hitting SQL with NaN', async () => {
    db.insert(makeRequest({ id: 'ws-4', kind: 'websocket', status: 101 }));
    const res = await httpReq(port, '/api/requests/ws-4/messages?limit=abc');
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/non-negative integers/);
  });

  it('GET /api/requests/:id/messages rejects a negative offset', async () => {
    db.insert(makeRequest({ id: 'ws-4', kind: 'websocket', status: 101 }));
    const res = await httpReq(port, '/api/requests/ws-4/messages?offset=-1');
    expect(res.status).toBe(400);
  });

  it('GET /api/requests/:id/messages treats limit=0 as "zero rows", distinct from the default', async () => {
    db.insert(makeRequest({ id: 'ws-5', kind: 'websocket', status: 101 }));
    db.insertWebSocketMessages([
      { id: 'm5', request_id: 'ws-5', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('x'), size: 1, truncated: 0 },
    ]);
    const res = await httpReq(port, '/api/requests/ws-5/messages?limit=0');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.limit).toBe(0);
    expect(body.total).toBe(1);
    expect(body.data).toEqual([]);
  });

  it('POST /api/websocket/replay replays a recorded connection by id', async () => {
    const server = await startRawWsServer({ onMessage: echoHandler });
    try {
      db.insert(makeRequest({
        id: 'ws-replay',
        kind: 'websocket',
        status: 101,
        url: `http://127.0.0.1:${server.port}/live`,
      }));
      db.insertWebSocketMessages([
        { id: 'r1', request_id: 'ws-replay', timestamp: 1000, direction: 'sent',
          opcode: 'text', payload: Buffer.from('one'), size: 3, truncated: 0 },
        // Neither of these is resent: replay drives the client half only.
        { id: 'r2', request_id: 'ws-replay', timestamp: 1000, direction: 'received',
          opcode: 'text', payload: Buffer.from('re:one'), size: 6, truncated: 0 },
        { id: 'r3', request_id: 'ws-replay', timestamp: 1010, direction: 'sent',
          opcode: 'ping', payload: null, size: 0, truncated: 0 },
      ]);

      const res = await httpReq(port, '/api/websocket/replay', 'POST', { requestId: 'ws-replay' });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.error).toBeUndefined();
      expect(body.sentCount).toBe(1);
      expect(body.received.map((r: { payload: string }) =>
        Buffer.from(r.payload, 'base64').toString())).toEqual(['re:one']);
    } finally {
      server.close();
    }
  }, 20_000);

  it('POST /api/websocket/replay accepts an explicit url and frames', async () => {
    const server = await startRawWsServer({ onMessage: echoHandler });
    try {
      const res = await httpReq(port, '/api/websocket/replay', 'POST', {
        url: `ws://127.0.0.1:${server.port}/adhoc`,
        frames: [{ opcode: 'text', payload: Buffer.from('hi').toString('base64'), delayMs: 0 }],
        timeoutMs: 5000,
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sentCount).toBe(1);
      expect(Buffer.from(body.received[0].payload, 'base64').toString()).toBe('re:hi');
    } finally {
      server.close();
    }
  }, 20_000);

  it('POST /api/websocket/replay refuses a connection with a truncated client frame', async () => {
    db.insert(makeRequest({ id: 'ws-cut', kind: 'websocket', status: 101, url: 'ws://127.0.0.1:1/x' }));
    db.insertWebSocketMessages([
      // Recorded payload is a prefix: `size` is the true length, `truncated: 1`
      // says the rest was clipped at maxBodySize. Resending the prefix would
      // deliver a corrupted message while reporting success.
      { id: 'c1', request_id: 'ws-cut', timestamp: 1000, direction: 'sent',
        opcode: 'text', payload: Buffer.from('{"a":1'), size: 1_500_000, truncated: 1 },
    ]);

    const res = await httpReq(port, '/api/websocket/replay', 'POST', { requestId: 'ws-cut' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/truncated/i);
  });

  it('POST /api/websocket/replay still replays when only a server frame was truncated', async () => {
    // A clipped *reply* says nothing about the fidelity of what replay sends, so
    // refusing here would be a false refusal on a perfectly replayable capture.
    const server = await startRawWsServer({ onMessage: echoHandler });
    try {
      db.insert(makeRequest({
        id: 'ws-cut-rx',
        kind: 'websocket',
        status: 101,
        url: `http://127.0.0.1:${server.port}/rx`,
      }));
      db.insertWebSocketMessages([
        { id: 'x1', request_id: 'ws-cut-rx', timestamp: 1000, direction: 'sent',
          opcode: 'text', payload: Buffer.from('ping'), size: 4, truncated: 0 },
        { id: 'x2', request_id: 'ws-cut-rx', timestamp: 1001, direction: 'received',
          opcode: 'text', payload: Buffer.from('huge'), size: 1_500_000, truncated: 1 },
      ]);

      const res = await httpReq(port, '/api/websocket/replay', 'POST', { requestId: 'ws-cut-rx' });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sentCount).toBe(1);
      expect(Buffer.from(body.received[0].payload, 'base64').toString()).toBe('re:ping');
    } finally {
      server.close();
    }
  }, 20_000);

  it('POST /api/websocket/replay rejects a payload that is not really base64', async () => {
    // Buffer.from() discards unrecognised characters instead of throwing, so an
    // unvalidated payload replays as arbitrary bytes under a 200.
    const res = await httpReq(port, '/api/websocket/replay', 'POST', {
      url: 'ws://127.0.0.1:1/x',
      frames: [{ opcode: 'text', payload: 'hello world!', delayMs: 0 }],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/base64/i);
  });

  it('POST /api/websocket/replay caps the frame count on the explicit-url form', async () => {
    // Reported by count before the per-frame shape pass, so the ceiling is what
    // a caller hears regardless of what the entries look like. Values are kept
    // tiny deliberately: express.json()'s 100kb default would otherwise reject
    // the body before the endpoint ever sees it.
    const res = await httpReq(port, '/api/websocket/replay', 'POST', {
      url: 'ws://127.0.0.1:1/x',
      frames: Array.from({ length: 10_001 }, () => 0),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Too many frames: 10001/);
  });

  it('POST /api/websocket/replay refuses a connection with more frames than it can replay', async () => {
    db.insert(makeRequest({ id: 'ws-huge', kind: 'websocket', status: 101 }));
    // One past the 10 000-frame ceiling. Replaying the first 10 000 and
    // reporting success would misrepresent what was sent.
    db.insertWebSocketMessages(Array.from({ length: 10_001 }, (_, i) => ({
      id: `h${i}`, request_id: 'ws-huge', timestamp: 1000 + i, direction: 'sent' as const,
      opcode: 'text' as const, payload: Buffer.from('x'), size: 1, truncated: 0,
    })));

    const res = await httpReq(port, '/api/websocket/replay', 'POST', { requestId: 'ws-huge' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/10001 recorded frames/);
  }, 20_000);

  it('POST /api/websocket/replay returns 404 for an unknown requestId', async () => {
    const res = await httpReq(port, '/api/websocket/replay', 'POST', { requestId: 'nope' });
    expect(res.status).toBe(404);
    // The endpoint's own 404, not Express's route-miss page.
    expect(JSON.parse(res.body).error).toBe('Not found');
  });

  it('POST /api/websocket/replay refuses a request that is not a websocket', async () => {
    db.insert(makeRequest({ id: 'plain-http' }));
    const res = await httpReq(port, '/api/websocket/replay', 'POST', { requestId: 'plain-http' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not a WebSocket/i);
  });

  it('POST /api/websocket/replay requires either a requestId or url and frames', async () => {
    const res = await httpReq(port, '/api/websocket/replay', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /api/websocket/replay rejects a non-ws url', async () => {
    const res = await httpReq(port, '/api/websocket/replay', 'POST', {
      url: 'https://example.com/x',
      frames: [],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/ws:\/\//);
  });

  it('POST /api/websocket/replay rejects a malformed frame instead of reporting a send failure', async () => {
    const res = await httpReq(port, '/api/websocket/replay', 'POST', {
      url: 'ws://127.0.0.1:1/x',
      frames: [{ opcode: 'text' }],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/frame/i);
  });

  it('POST /api/websocket/replay rejects a non-numeric timeoutMs rather than timing out at once', async () => {
    // setTimeout(NaN) fires immediately, which would surface a client mistake as
    // a 200 carrying "Replay timed out".
    const res = await httpReq(port, '/api/websocket/replay', 'POST', {
      url: 'ws://127.0.0.1:1/x',
      frames: [],
      timeoutMs: 'soon',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/timeoutMs/);
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

describe('REST API SSE ws-message forwarding', () => {
  let db: Database;
  let dbPath: string;
  let events: SpyEventManager;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `laurel-proxy-api-test-${randomUUID()}.db`);
    db = new Database(dbPath);
    events = new SpyEventManager();
    const app = express();
    app.use(express.json());
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

  it('forwards messages pushed on the EventManager ws-message channel as SSE ws-message events', async () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' });
    const sse = await new Promise<ReturnType<typeof collectSse>>((resolve, reject) => {
      req.on('response', (res) => resolve(collectSse(res)));
      req.on('error', reject);
    });

    try {
      const message: WebSocketMessage = {
        id: 'm1', request_id: 'ws-1', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('hi'), size: 2, truncated: 0,
      };
      events.pushWsMessages([message]);

      const data = await sse.waitFor('ws-message');
      const parsed = JSON.parse(data);
      expect(parsed.id).toBe('m1');
      expect(parsed.request_id).toBe('ws-1');
      // Confirms JSON.stringify is applied to the whole data object (not just
      // pieces of it): a base64 payload round-trips intact through the
      // `data: <json>` line.
      expect(Buffer.from(parsed.payload, 'base64').toString()).toBe('hi');
    } finally {
      req.destroy();
    }
  });

  it('unsubscribes the ws-message channel when the SSE connection closes', async () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' });
    await new Promise<void>((resolve, reject) => {
      req.on('response', () => resolve());
      req.on('error', reject);
    });

    expect(events.wsSubscribeCalls).toBe(1);
    expect(events.wsUnsubscribeCalls).toBe(0);

    req.destroy();
    // The server's `req.on('close', ...)` cleanup handler runs asynchronously
    // relative to the client tearing down its own socket, so give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.wsUnsubscribeCalls).toBe(1);
  });
});
