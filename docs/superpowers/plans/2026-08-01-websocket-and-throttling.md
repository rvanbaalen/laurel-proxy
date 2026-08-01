# WebSocket Capture and Bandwidth Throttling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two Charles Proxy feature gaps in Laurel Proxy — WebSocket traffic capture with replay, and bandwidth/latency throttling — on top of a unified request-exchange pipeline that replaces the current duplicated proxy handlers.

**Architecture:** `src/server/proxy.ts` currently contains two near-identical ~70-line handlers (`handleRequest` for HTTP, `handleMitmRequest` for HTTPS) that fully buffer responses before writing them. Task 1 collapses both into one streaming `src/server/exchange.ts` pipeline; that streaming behaviour is what makes throttling possible at all. WebSocket support is added as a third dispatch path (`upgrade`) that relays bytes untouched while a passive RFC 6455 decoder observes them.

**Tech Stack:** TypeScript (ESM, `nodenext`), Node 22.21.1, `node:http`/`node:https`/`node:net`/`node:tls`, better-sqlite3, Express 5, React 19 + Tailwind 4 (web UI), Ink 6 (CLI TUI), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-01-charles-parity-design.md`

**A note on task detail:** every server, storage, and CLI task below contains
complete, literal code. The two web-UI tasks (6 and 13) instead specify the client
methods literally and describe the component changes, because the exact JSX must
match the existing structure of `Controls.tsx` and `RequestDetail.tsx`. Read those
files before implementing those two tasks.

## Global Constraints

- Node 22+ required. `globalThis.WebSocket` (used in Task 12) is stable in Node 22; do not add a WebSocket dependency such as `ws`.
- **No new runtime dependencies.** Everything here uses Node built-ins plus what is already in `package.json`.
- **No desktop UI.** Surfaces are CLI, web UI, and REST API only.
- **Do not edit the `laurelproxy-website` repo.** Its Charles comparison page is updated separately after this ships.
- ESM only: every relative import must carry a `.js` extension, including from `.ts` sources.
- Recorded bodies and WebSocket payloads cap at `config.maxBodySize` (default 1 MiB) and set `truncated: 1` when clipped.
- Out of scope for this plan: HTTP/2, Windows support, rewrite rules, Map Local/Remote, breakpoints (separate plan).
- Traffic fidelity is the top invariant: a recording bug must never alter bytes the application sees.
- Run `npm test` before every commit. The existing suite covers the code Task 1 refactors and must stay green throughout.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/server/exchange.ts` | Create (T1) | One HTTP exchange end-to-end: buffer request, call upstream, stream response through throttle, record |
| `src/server/proxy.ts` | Modify (T1, T9) | Listener + socket lifecycle + dispatch of `request` / `connect` / `upgrade` only |
| `src/server/throttle.ts` | Create (T2) | Shared-pipe rate limiters, presets, latency injection |
| `src/server/ws-frames.ts` | Create (T7) | Pure RFC 6455 frame decoder |
| `src/server/websocket.ts` | Create (T9) | Upgrade forwarding, byte relay, passive frame observation |
| `src/server/ws-replay.ts` | Create (T12) | Re-open a recorded connection and resend its client frames |
| `src/shared/types.ts` | Modify (T2, T3, T8, T12) | New shared types |
| `src/storage/db.ts` | Modify (T8) | `websocket_messages` table, `kind` column migration, insert/query |
| `src/server/events.ts` | Modify (T10) | WebSocket message pub/sub |
| `src/server/api.ts` | Modify (T4, T10, T12) | Throttle, messages, WS-replay endpoints |
| `src/server/config.ts` | Modify (T3) | Load/persist `throttle` settings |
| `src/server/index.ts` | Modify (T3) | Own the `Throttler`, expose it to API |
| `src/cli/commands/throttle.ts` | Create (T5) | `laurel-proxy throttle` |
| `src/cli/commands/messages.ts` | Create (T11) | `laurel-proxy messages` |
| `src/cli/index.ts` | Modify (T5, T11) | Register new commands |
| `src/cli/format.ts` | Modify (T11) | Format WebSocket messages + throttle status |
| `src/ui/components/Controls.tsx` | Modify (T6) | Throttle control |
| `src/ui/components/RequestDetail.tsx` | Modify (T13) | Messages tab |
| `src/ui/client.ts` | Modify (T6, T13) | API client methods |

---

## Phase 1 — Foundation

### Task 1: Collapse the duplicated proxy handlers into a streaming exchange pipeline

This is a **pure refactor with two intentional behaviour changes** (responses stream instead of fully buffering; `content-length` is preserved from upstream rather than always recomputed). No new features. The existing test suite is the safety net.

**Files:**
- Create: `src/server/exchange.ts`
- Modify: `src/server/proxy.ts` (replace `handleRequest` lines 81-170 and `handleMitmRequest` lines 202-283)
- Test: `src/server/exchange.test.ts`, `tests/integration/proxy.integration.test.ts` (add cases)

**Interfaces:**
- Consumes: `RequestRecord`, `Config` from `src/shared/types.js`
- Produces:
  ```ts
  export interface ExchangeTarget {
    hostname: string;
    port: number;
    protocol: 'http' | 'https';
    url: string;   // full URL as recorded
    path: string;  // origin-form path sent upstream
  }
  export interface ExchangeDeps {
    config: Config;
    onRecord: (record: RequestRecord) => void;
  }
  export function resolveHttpTarget(rawUrl: string): ExchangeTarget | null;
  export function resolveMitmTarget(hostname: string, port: number, rawPath: string): ExchangeTarget;
  export async function handleExchange(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    target: ExchangeTarget,
    deps: ExchangeDeps,
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test for target resolution**

Create `src/server/exchange.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveHttpTarget, resolveMitmTarget } from './exchange.js';

describe('resolveHttpTarget', () => {
  it('parses an absolute-form proxy URL', () => {
    expect(resolveHttpTarget('http://example.com/a/b?c=1')).toEqual({
      hostname: 'example.com',
      port: 80,
      protocol: 'http',
      url: 'http://example.com/a/b?c=1',
      path: '/a/b?c=1',
    });
  });

  it('honours an explicit port', () => {
    expect(resolveHttpTarget('http://example.com:8080/x')?.port).toBe(8080);
  });

  it('returns null for a non-absolute URL', () => {
    expect(resolveHttpTarget('/relative')).toBeNull();
  });
});

describe('resolveMitmTarget', () => {
  it('builds an https target from CONNECT host and path', () => {
    expect(resolveMitmTarget('example.com', 443, '/a?b=2')).toEqual({
      hostname: 'example.com',
      port: 443,
      protocol: 'https',
      url: 'https://example.com/a?b=2',
      path: '/a?b=2',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/exchange.test.ts`
Expected: FAIL — `Failed to resolve import "./exchange.js"`

- [ ] **Step 3: Create the exchange module**

Create `src/server/exchange.ts`:

```ts
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import type { Config, RequestRecord } from '../shared/types.js';

export interface ExchangeTarget {
  hostname: string;
  port: number;
  protocol: 'http' | 'https';
  url: string;
  path: string;
}

export interface ExchangeDeps {
  config: Config;
  onRecord: (record: RequestRecord) => void;
}

/** Hop-by-hop headers that must not be forwarded upstream. */
const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization'];

export function resolveHttpTarget(rawUrl: string): ExchangeTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 80,
    protocol: 'http',
    url: rawUrl,
    path: parsed.pathname + parsed.search,
  };
}

export function resolveMitmTarget(hostname: string, port: number, rawPath: string): ExchangeTarget {
  return {
    hostname,
    port,
    protocol: 'https',
    url: `https://${hostname}${rawPath}`,
    path: rawPath,
  };
}

function readBody(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function handleExchange(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  target: ExchangeTarget,
  deps: ExchangeDeps,
): Promise<void> {
  const startTime = Date.now();
  const id = randomUUID();
  const { config } = deps;

  let requestBody: Buffer;
  try {
    requestBody = await readBody(clientReq);
  } catch {
    return;
  }

  const upstreamHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
  for (const name of HOP_BY_HOP) delete upstreamHeaders[name];
  // Ask upstream for an uncompressed body so no decompression path is needed.
  delete upstreamHeaders['accept-encoding'];
  if (target.protocol === 'https') upstreamHeaders.host = target.hostname;

  const transport = target.protocol === 'https' ? https : http;
  const options: https.RequestOptions = {
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: clientReq.method,
    headers: upstreamHeaders,
    ...(target.protocol === 'https' ? { rejectUnauthorized: false } : {}),
  };

  let proxyRes: http.IncomingMessage;
  try {
    proxyRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = transport.request(options, resolve);
      req.on('error', reject);
      if (requestBody.length > 0) req.write(requestBody);
      req.end();
    });
  } catch {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end('Bad Gateway');
    }
    return;
  }

  const resHeaders = { ...proxyRes.headers };
  // We re-frame the response ourselves; upstream framing must not leak through.
  delete resHeaders['transfer-encoding'];
  clientRes.writeHead(proxyRes.statusCode ?? 500, resHeaders);

  const captured: Buffer[] = [];
  let capturedLength = 0;
  let responseSize = 0;

  try {
    for await (const chunk of proxyRes as AsyncIterable<Buffer>) {
      responseSize += chunk.length;
      if (capturedLength < config.maxBodySize) {
        const slice = chunk.subarray(0, config.maxBodySize - capturedLength);
        captured.push(slice);
        capturedLength += slice.length;
      }
      if (!clientRes.write(chunk)) await once(clientRes, 'drain');
    }
    clientRes.end();
  } catch {
    clientRes.destroy();
  }

  const responseBody = Buffer.concat(captured);
  const truncated =
    requestBody.length > config.maxBodySize || responseSize > config.maxBodySize;
  const contentType =
    (proxyRes.headers['content-type'] || '').split(';')[0].trim() || null;

  deps.onRecord({
    id,
    timestamp: startTime,
    method: clientReq.method || 'GET',
    url: target.url,
    host: target.hostname,
    path: new URL(target.url).pathname || '/',
    protocol: target.protocol,
    request_headers: JSON.stringify(clientReq.headers),
    request_body:
      requestBody.length > 0 ? requestBody.subarray(0, config.maxBodySize) : null,
    request_size: requestBody.length,
    status: proxyRes.statusCode ?? 0,
    response_headers: JSON.stringify(proxyRes.headers),
    response_body: responseBody.length > 0 ? responseBody : null,
    response_size: responseSize,
    duration: Date.now() - startTime,
    content_type: contentType,
    truncated: truncated ? 1 : 0,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/exchange.test.ts`
Expected: PASS (6 assertions)

- [ ] **Step 5: Rewrite proxy.ts to dispatch into the pipeline**

In `src/server/proxy.ts`: delete `handleRequest`, `handleMitmRequest`, and `stripEncoding` entirely. Add the import and the two dispatch methods. Keep `start`, `stop`, `port`, `flushWrites`, and `handleConnect`'s TLS setup unchanged.

```ts
import { handleExchange, resolveHttpTarget, resolveMitmTarget } from './exchange.js';
import type { ExchangeDeps } from './exchange.js';
```

Add a private accessor and replace the two handler call sites:

```ts
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
```

And inside `handleConnect`, replace the virtual server callback:

```ts
      const virtualServer = http.createServer((clientReq, clientRes) => {
        const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
        void handleExchange(clientReq, clientRes, target, this.exchangeDeps);
      });
```

- [ ] **Step 6: Run the whole suite to prove the refactor is behaviour-preserving**

Run: `npm test`
Expected: PASS — every pre-existing test in `src/server/proxy.test.ts`, `src/server/api.test.ts`, and `tests/integration/proxy.integration.test.ts` still green. If any fail, the refactor is wrong; fix the pipeline rather than the test.

- [ ] **Step 7: Add an integration test proving responses stream**

Append to `tests/integration/proxy.integration.test.ts` (match the existing describe block's setup helpers):

```ts
  it('relays a chunked response without buffering it whole', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first-');
      res.write('second-');
      res.end('third');
    });
    await new Promise<void>((r) => upstream.listen(0, r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const res = await proxiedGet(`http://127.0.0.1:${upstreamPort}/chunked`);
    expect(res.body).toBe('first-second-third');
    // No transfer-encoding leaks through; we re-frame the response ourselves.
    expect(res.headers['transfer-encoding']).toBeUndefined();

    upstream.close();
  });
```

- [ ] **Step 8: Run it**

Run: `npx vitest run tests/integration/proxy.integration.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/server/exchange.ts src/server/exchange.test.ts src/server/proxy.ts tests/integration/proxy.integration.test.ts
git commit -m "refactor: unify HTTP and HTTPS proxy handlers into a streaming exchange pipeline"
```

---

## Phase 2 — Bandwidth throttling

### Task 2: Rate limiter and presets

**Note on terminology:** the spec calls this a "token bucket". The implementation is a *shared-pipe reservation scheduler* — each caller reserves a slot on a single virtual link, so N concurrent connections contend for one pipe. This delivers the spec's stated guarantee more directly than a refilling bucket and has no burst allowance, which matches a real bandwidth-limited link. Deliberate deviation, same observable behaviour.

**Files:**
- Create: `src/server/throttle.ts`
- Test: `src/server/throttle.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Clock { now(): number; sleep(ms: number): Promise<void>; }
  export const realClock: Clock;
  export class RateLimiter {
    constructor(bytesPerSec: number, clock?: Clock);
    setRate(bytesPerSec: number): void;
    consume(bytes: number): Promise<void>;
  }
  export const THROTTLE_PRESETS: Record<string, ThrottleProfile>;
  export class Throttler {
    constructor(settings: ThrottleSettings, clock?: Clock);
    readonly down: RateLimiter;
    readonly up: RateLimiter;
    getSettings(): ThrottleSettings;
    update(settings: ThrottleSettings): void;
    delayLatency(): Promise<void>;
  }
  export function kbpsToBytesPerSec(kbps: number): number;
  ```
  Types `ThrottleProfile` / `ThrottleSettings` are added to `src/shared/types.ts` in this task.

- [ ] **Step 1: Write the failing tests**

Create `src/server/throttle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RateLimiter, Throttler, THROTTLE_PRESETS, kbpsToBytesPerSec } from './throttle.js';
import type { Clock } from './throttle.js';

/** Deterministic clock: sleep advances virtual time instantly. */
function fakeClock(): Clock & { elapsed: number } {
  const c = {
    elapsed: 0,
    now: () => c.elapsed,
    sleep: async (ms: number) => { c.elapsed += ms; },
  };
  return c;
}

describe('kbpsToBytesPerSec', () => {
  it('converts kilobits per second to bytes per second', () => {
    expect(kbpsToBytesPerSec(8)).toBe(1000);
    expect(kbpsToBytesPerSec(1000)).toBe(125_000);
  });
});

describe('RateLimiter', () => {
  it('does not delay when the rate is unlimited', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(0, clock);
    await limiter.consume(10_000_000);
    expect(clock.elapsed).toBe(0);
  });

  it('paces a single consumer to the configured rate', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock); // 1000 B/s
    await limiter.consume(1000);
    expect(clock.elapsed).toBe(1000); // 1 second for 1000 bytes
  });

  it('serialises concurrent consumers onto one shared pipe', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock);
    await limiter.consume(500);
    await limiter.consume(500);
    // Two 500-byte reservations on a 1000 B/s link total 1 second.
    expect(clock.elapsed).toBe(1000);
  });

  it('applies a new rate to subsequent reservations', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock);
    limiter.setRate(2000);
    await limiter.consume(1000);
    expect(clock.elapsed).toBe(500);
  });

  it('ignores zero-length reads', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock);
    await limiter.consume(0);
    expect(clock.elapsed).toBe(0);
  });
});

describe('THROTTLE_PRESETS', () => {
  it('exposes the six documented presets', () => {
    expect(Object.keys(THROTTLE_PRESETS).sort()).toEqual(
      ['3g', '4g', '56k', 'dsl', 'edge', 'wifi'].sort(),
    );
  });

  it('matches the spec values for 3g', () => {
    expect(THROTTLE_PRESETS['3g']).toEqual({ downKbps: 780, upKbps: 330, latencyMs: 100 });
  });
});

describe('Throttler', () => {
  it('is a no-op when disabled', async () => {
    const clock = fakeClock();
    const t = new Throttler({ enabled: false, downKbps: 780, upKbps: 330, latencyMs: 100 }, clock);
    await t.down.consume(10_000);
    await t.delayLatency();
    expect(clock.elapsed).toBe(0);
  });

  it('applies latency once when enabled', async () => {
    const clock = fakeClock();
    const t = new Throttler({ enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 }, clock);
    await t.delayLatency();
    expect(clock.elapsed).toBe(100);
  });

  it('reconfigures rates in place via update', async () => {
    const clock = fakeClock();
    const t = new Throttler({ enabled: true, downKbps: 8, upKbps: 8, latencyMs: 0 }, clock);
    t.update({ enabled: true, downKbps: 16, upKbps: 8, latencyMs: 0 });
    await t.down.consume(1000); // 16 kbps = 2000 B/s
    expect(clock.elapsed).toBe(500);
    expect(t.getSettings().downKbps).toBe(16);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/throttle.test.ts`
Expected: FAIL — `Failed to resolve import "./throttle.js"`

- [ ] **Step 3: Add the shared types**

Append to `src/shared/types.ts`:

```ts
export interface ThrottleProfile {
  downKbps: number;
  upKbps: number;
  latencyMs: number;
}

export interface ThrottleSettings extends ThrottleProfile {
  enabled: boolean;
}

export const DEFAULT_THROTTLE: ThrottleSettings = {
  enabled: false,
  downKbps: 0,
  upKbps: 0,
  latencyMs: 0,
};
```

- [ ] **Step 4: Implement the throttler**

Create `src/server/throttle.ts`:

```ts
import type { ThrottleProfile, ThrottleSettings } from '../shared/types.js';
import { DEFAULT_THROTTLE } from '../shared/types.js';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function kbpsToBytesPerSec(kbps: number): number {
  return Math.round((kbps * 1000) / 8);
}

/**
 * Models one shared bandwidth-limited link. Each consume() reserves the time
 * slice needed to transmit `bytes` and waits for it, so concurrent callers
 * queue behind one another rather than each receiving the full rate.
 */
export class RateLimiter {
  private nextFreeAt = 0;

  constructor(
    private bytesPerSec: number,
    private clock: Clock = realClock,
  ) {}

  setRate(bytesPerSec: number): void {
    this.bytesPerSec = bytesPerSec;
  }

  async consume(bytes: number): Promise<void> {
    if (this.bytesPerSec <= 0 || bytes <= 0) return;
    const now = this.clock.now();
    // An idle link resets to now, so pauses do not bank credit.
    const startAt = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = startAt + (bytes / this.bytesPerSec) * 1000;
    const waitMs = Math.ceil(this.nextFreeAt - now);
    if (waitMs > 0) await this.clock.sleep(waitMs);
  }
}

export const THROTTLE_PRESETS: Record<string, ThrottleProfile> = {
  '56k': { downKbps: 56, upKbps: 33, latencyMs: 120 },
  edge: { downKbps: 240, upKbps: 200, latencyMs: 400 },
  '3g': { downKbps: 780, upKbps: 330, latencyMs: 100 },
  '4g': { downKbps: 4000, upKbps: 3000, latencyMs: 20 },
  dsl: { downKbps: 2000, upKbps: 256, latencyMs: 40 },
  wifi: { downKbps: 30000, upKbps: 15000, latencyMs: 5 },
};

export class Throttler {
  readonly down: RateLimiter;
  readonly up: RateLimiter;
  private settings: ThrottleSettings;

  constructor(
    settings: ThrottleSettings = DEFAULT_THROTTLE,
    private clock: Clock = realClock,
  ) {
    this.settings = settings;
    this.down = new RateLimiter(this.rate(settings.downKbps, settings.enabled), clock);
    this.up = new RateLimiter(this.rate(settings.upKbps, settings.enabled), clock);
  }

  private rate(kbps: number, enabled: boolean): number {
    return enabled && kbps > 0 ? kbpsToBytesPerSec(kbps) : 0;
  }

  getSettings(): ThrottleSettings {
    return { ...this.settings };
  }

  update(settings: ThrottleSettings): void {
    this.settings = settings;
    this.down.setRate(this.rate(settings.downKbps, settings.enabled));
    this.up.setRate(this.rate(settings.upKbps, settings.enabled));
  }

  /** Injected once per HTTP exchange, before the first response byte. */
  async delayLatency(): Promise<void> {
    if (!this.settings.enabled || this.settings.latencyMs <= 0) return;
    await this.clock.sleep(this.settings.latencyMs);
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/server/throttle.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/throttle.ts src/server/throttle.test.ts src/shared/types.ts
git commit -m "feat: add bandwidth rate limiter with network presets"
```

---

### Task 3: Wire the throttler into the exchange pipeline and config

**Files:**
- Modify: `src/server/exchange.ts`, `src/server/proxy.ts`, `src/server/config.ts`, `src/server/index.ts`, `src/shared/types.ts`
- Test: `tests/integration/throttle.integration.test.ts`

**Interfaces:**
- Consumes: `Throttler` from Task 2
- Produces: `ExchangeDeps` gains `throttle?: Throttler`; `Config` gains `throttle: ThrottleSettings`; `LaurelProxyServer` gains `get throttler(): Throttler`; `ProxyServer` gains `setThrottler(t: Throttler): void`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/throttle.integration.test.ts`:

```ts
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
    // 64 KiB body: at 8 kbps (1000 B/s) this must take >= ~65s, so we use a
    // faster rate and a smaller body to keep the test quick but unambiguous.
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
    // 80 kbps = 10_000 B/s, so 20_000 bytes needs ~2s.
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/throttle.integration.test.ts`
Expected: FAIL — `server.throttler` is not a property of `LaurelProxyServer`

- [ ] **Step 3: Add `throttle` to Config**

In `src/shared/types.ts`, add the field to `Config` and the default:

```ts
export interface Config {
  proxyPort: number;
  uiPort: number;
  dbPath: string;
  maxAge: number;
  maxDbSize: number;
  maxBodySize: number;
  certCacheSize: number;
  throttle: ThrottleSettings;
}
```

In `DEFAULT_CONFIG` add: `throttle: DEFAULT_THROTTLE,`

`DEFAULT_THROTTLE` is declared later in the file than `DEFAULT_CONFIG`; move the throttle types and `DEFAULT_THROTTLE` **above** `DEFAULT_CONFIG` so the reference resolves.

- [ ] **Step 4: Load and persist throttle settings**

In `src/server/config.ts`, inside the `fileConfig` object literal add:

```ts
        throttle: raw.throttle,
```

Then add a persistence helper at the end of the file:

```ts
import type { ThrottleSettings } from '../shared/types.js';

/** Persist throttle settings back to the config file, preserving other keys. */
export function saveThrottleSettings(settings: ThrottleSettings): void {
  const configPath = expandHome('~/.laurel-proxy/config.json');
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      raw = {};
    }
  }
  raw.throttle = settings;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
}
```

- [ ] **Step 5: Thread the throttler through exchange and proxy**

In `src/server/exchange.ts`, add to the imports and the deps interface:

```ts
import type { Throttler } from './throttle.js';
```
```ts
export interface ExchangeDeps {
  config: Config;
  onRecord: (record: RequestRecord) => void;
  throttle?: Throttler;
}
```

Pace the upload by replacing the upstream write block:

```ts
      const req = transport.request(options, resolve);
      req.on('error', reject);
      if (requestBody.length > 0) {
        void deps.throttle?.up.consume(requestBody.length).then(() => {
          req.write(requestBody);
          req.end();
        });
      } else {
        req.end();
      }
```

Inject latency immediately before `clientRes.writeHead`:

```ts
  await deps.throttle?.delayLatency();

  const resHeaders = { ...proxyRes.headers };
```

Pace the download inside the streaming loop, before the write:

```ts
      await deps.throttle?.down.consume(chunk.length);
      if (!clientRes.write(chunk)) await once(clientRes, 'drain');
```

In `src/server/proxy.ts`, hold and expose the throttler:

```ts
import type { Throttler } from './throttle.js';
```
```ts
  private throttler: Throttler | null = null;

  setThrottler(throttler: Throttler): void {
    this.throttler = throttler;
  }
```
and add `throttle: this.throttler ?? undefined,` to the object returned by `exchangeDeps`.

- [ ] **Step 6: Own the throttler in the server**

In `src/server/index.ts`, import and instantiate:

```ts
import { Throttler } from './throttle.js';
```
In the constructor, after `this.proxy = ...`:
```ts
    this.throttleController = new Throttler(config.throttle);
    this.proxy.setThrottler(this.throttleController);
```
Add the field and a public accessor:
```ts
  private throttleController: Throttler;

  get throttler(): Throttler {
    return this.throttleController;
  }
```

- [ ] **Step 7: Run the throttle integration test**

Run: `npx vitest run tests/integration/throttle.integration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — nothing regressed. `loadConfig` callers that build a `Config` literal in tests may now fail type-checking on the missing `throttle` key; add `throttle: DEFAULT_THROTTLE` to those literals.

- [ ] **Step 9: Commit**

```bash
git add src/server/exchange.ts src/server/proxy.ts src/server/config.ts src/server/index.ts src/shared/types.ts tests/integration/throttle.integration.test.ts
git commit -m "feat: apply bandwidth throttling and latency to proxied exchanges"
```

---

### Task 4: Throttle REST endpoints

**Files:**
- Modify: `src/server/api.ts`, `src/server/index.ts`
- Test: `src/server/api.test.ts` (add cases)

**Interfaces:**
- Consumes: `Throttler`, `THROTTLE_PRESETS` from Task 2
- Produces: `createApiRouter(db, events, proxy, ca?, throttler?)` — new trailing optional parameter. `GET /api/throttle` → `{ settings, presets }`; `PUT /api/throttle` with `{ preset }` or `{ enabled, downKbps, upKbps, latencyMs }` → `{ settings }`

- [ ] **Step 1: Write the failing tests**

Add to `src/server/api.test.ts`, following the existing supertest-or-fetch harness in that file:

```ts
  it('GET /api/throttle returns current settings and presets', async () => {
    const res = await request('GET', '/api/throttle');
    expect(res.status).toBe(200);
    expect(res.body.settings.enabled).toBe(false);
    expect(res.body.presets['3g']).toEqual({ downKbps: 780, upKbps: 330, latencyMs: 100 });
  });

  it('PUT /api/throttle applies a named preset', async () => {
    const res = await request('PUT', '/api/throttle', { preset: '3g' });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100,
    });
  });

  it('PUT /api/throttle applies custom values', async () => {
    const res = await request('PUT', '/api/throttle', {
      enabled: true, downKbps: 500, upKbps: 250, latencyMs: 50,
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.downKbps).toBe(500);
  });

  it('PUT /api/throttle rejects an unknown preset', async () => {
    const res = await request('PUT', '/api/throttle', { preset: 'carrier-pigeon' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown preset');
  });

  it('PUT /api/throttle rejects a negative rate', async () => {
    const res = await request('PUT', '/api/throttle', { enabled: true, downKbps: -5 });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/api.test.ts`
Expected: FAIL — 404 on `/api/throttle`

- [ ] **Step 3: Add the endpoints**

In `src/server/api.ts`, extend the signature and add routes:

```ts
import type { Throttler } from './throttle.js';
import { THROTTLE_PRESETS } from './throttle.js';
import { saveThrottleSettings } from './config.js';
import type { ThrottleSettings } from '../shared/types.js';
```
```ts
export function createApiRouter(
  db: Database,
  events: EventManager,
  proxy: ProxyControl,
  ca?: CertificateAuthority,
  throttler?: Throttler,
): Router {
```
```ts
  router.get('/throttle', (_req: Request, res: Response) => {
    if (!throttler) {
      res.status(503).json({ error: 'Throttling not available' });
      return;
    }
    res.json({ settings: throttler.getSettings(), presets: THROTTLE_PRESETS });
  });

  router.put('/throttle', (req: Request, res: Response) => {
    if (!throttler) {
      res.status(503).json({ error: 'Throttling not available' });
      return;
    }
    const body = req.body as { preset?: string } & Partial<ThrottleSettings>;
    let settings: ThrottleSettings;

    if (body.preset !== undefined) {
      if (body.preset === 'off') {
        settings = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 };
      } else {
        const preset = THROTTLE_PRESETS[body.preset];
        if (!preset) {
          res.status(400).json({
            error: `Unknown preset "${body.preset}". Available: ${Object.keys(THROTTLE_PRESETS).join(', ')}, off`,
          });
          return;
        }
        settings = { enabled: true, ...preset };
      }
    } else {
      const current = throttler.getSettings();
      settings = {
        enabled: body.enabled ?? current.enabled,
        downKbps: body.downKbps ?? current.downKbps,
        upKbps: body.upKbps ?? current.upKbps,
        latencyMs: body.latencyMs ?? current.latencyMs,
      };
    }

    for (const key of ['downKbps', 'upKbps', 'latencyMs'] as const) {
      if (!Number.isFinite(settings[key]) || settings[key] < 0) {
        res.status(400).json({ error: `${key} must be a non-negative number` });
        return;
      }
    }

    throttler.update(settings);
    saveThrottleSettings(settings);
    res.json({ settings });
  });
```

In `src/server/index.ts`, pass it through:

```ts
    app.use('/api', createApiRouter(this.db, this.events, proxyControl, this.ca, this.throttleController));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/api.ts src/server/api.test.ts src/server/index.ts
git commit -m "feat: add throttle configuration REST endpoints"
```

---

### Task 5: `laurel-proxy throttle` command

**Files:**
- Create: `src/cli/commands/throttle.ts`
- Modify: `src/cli/index.ts`, `src/cli/format.ts`
- Test: `src/cli/format.test.ts` (add cases)

**Interfaces:**
- Consumes: `PUT /api/throttle`, `GET /api/throttle` from Task 4
- Produces: `registerThrottle(program: Command): void`; `formatThrottleSettings(settings: ThrottleSettings, presets: Record<string, ThrottleProfile>, format: string): string`

- [ ] **Step 1: Write the failing formatter test**

Add to `src/cli/format.test.ts`:

```ts
import { formatThrottleSettings } from './format.js';
import { THROTTLE_PRESETS } from '../server/throttle.js';

describe('formatThrottleSettings', () => {
  it('reports disabled state in table format', () => {
    const out = formatThrottleSettings(
      { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 },
      THROTTLE_PRESETS,
      'table',
    );
    expect(out).toContain('disabled');
  });

  it('reports active rates in table format', () => {
    const out = formatThrottleSettings(
      { enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 },
      THROTTLE_PRESETS,
      'table',
    );
    expect(out).toContain('780');
    expect(out).toContain('330');
    expect(out).toContain('100');
  });

  it('emits parseable JSON', () => {
    const out = formatThrottleSettings(
      { enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 },
      THROTTLE_PRESETS,
      'json',
    );
    expect(JSON.parse(out).settings.downKbps).toBe(780);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/cli/format.test.ts`
Expected: FAIL — `formatThrottleSettings` is not exported

- [ ] **Step 3: Add the formatter**

Append to `src/cli/format.ts` (reuse the existing `COL` colour map):

```ts
export function formatThrottleSettings(
  settings: ThrottleSettings,
  presets: Record<string, ThrottleProfile>,
  format: string,
): string {
  if (format === 'json') return JSON.stringify({ settings, presets }, null, 2);

  if (!settings.enabled) {
    const names = Object.keys(presets).join(', ');
    return `Throttling: disabled\n\nPresets: ${names}\nEnable with: laurel-proxy throttle <preset>`;
  }

  return [
    'Throttling: enabled',
    `  Download: ${settings.downKbps} kbps`,
    `  Upload:   ${settings.upKbps} kbps`,
    `  Latency:  ${settings.latencyMs} ms`,
    '',
    'Disable with: laurel-proxy throttle off',
  ].join('\n');
}
```
Add `ThrottleSettings` and `ThrottleProfile` to the existing type import from `../shared/types.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/cli/format.test.ts`
Expected: PASS

- [ ] **Step 5: Create the command**

Create `src/cli/commands/throttle.ts`:

```ts
import type { Command } from 'commander';
import http from 'node:http';
import { formatThrottleSettings } from '../format.js';
import { THROTTLE_PRESETS } from '../../server/throttle.js';
import type { ThrottleSettings } from '../../shared/types.js';

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

function api(port: number, method: string, path: string, payload?: unknown): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 5000,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { error: text } });
          }
        });
      },
    );
    req.on('error', () => reject(new Error('Could not connect to proxy. Is it running?')));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

export function registerThrottle(program: Command): void {
  program
    .command('throttle [preset]')
    .description(`Simulate constrained network conditions (${Object.keys(THROTTLE_PRESETS).join(', ')}, off)`)
    .option('--down <kbps>', 'Downstream bandwidth in kbps')
    .option('--up <kbps>', 'Upstream bandwidth in kbps')
    .option('--latency <ms>', 'Added latency in milliseconds')
    .option('--status', 'Show current throttle settings')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .option('--ui-port <number>', 'UI/API port', '8081')
    .action(async (preset: string | undefined, opts) => {
      const port = parseInt(opts.uiPort, 10);

      try {
        if (opts.status || (!preset && !opts.down && !opts.up && !opts.latency)) {
          const res = await api(port, 'GET', '/api/throttle');
          if (res.status !== 200) {
            console.error(res.body.error ?? 'Failed to read throttle settings');
            process.exit(1);
          }
          console.log(
            formatThrottleSettings(
              res.body.settings as ThrottleSettings,
              res.body.presets as Record<string, never>,
              opts.format,
            ),
          );
          return;
        }

        const payload: Record<string, unknown> = {};
        if (preset) {
          payload.preset = preset;
        } else {
          payload.enabled = true;
          if (opts.down) payload.downKbps = Number(opts.down);
          if (opts.up) payload.upKbps = Number(opts.up);
          if (opts.latency) payload.latencyMs = Number(opts.latency);
        }

        const res = await api(port, 'PUT', '/api/throttle', payload);
        if (res.status !== 200) {
          console.error(res.body.error ?? 'Failed to update throttle settings');
          process.exit(1);
        }
        console.log(
          formatThrottleSettings(
            res.body.settings as ThrottleSettings,
            THROTTLE_PRESETS,
            opts.format,
          ),
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}
```

- [ ] **Step 6: Register it**

In `src/cli/index.ts`, add the import and the registration call alongside the others:

```ts
import { registerThrottle } from './commands/throttle.js';
```
```ts
registerThrottle(program);
```

- [ ] **Step 7: Verify end-to-end by hand**

```bash
npm run build
node dist/cli/index.js start &
sleep 3
node dist/cli/index.js throttle 3g
node dist/cli/index.js throttle --status
node dist/cli/index.js throttle off
node dist/cli/index.js stop
```
Expected: `3g` prints enabled with 780/330/100; `--status` agrees; `off` prints disabled.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/throttle.ts src/cli/index.ts src/cli/format.ts src/cli/format.test.ts
git commit -m "feat: add laurel-proxy throttle command"
```

---

### Task 6: Throttle control in the web UI

**Files:**
- Modify: `src/ui/client.ts`, `src/ui/components/Controls.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/throttle` from Task 4
- Produces: `getThrottle()`, `setThrottle(payload)` on the UI API client

- [ ] **Step 1: Add client methods**

In `src/ui/client.ts`, following the existing fetch-wrapper style in that file:

```ts
export interface ThrottleState {
  settings: { enabled: boolean; downKbps: number; upKbps: number; latencyMs: number };
  presets: Record<string, { downKbps: number; upKbps: number; latencyMs: number }>;
}

export async function getThrottle(): Promise<ThrottleState> {
  const res = await fetch('/api/throttle');
  if (!res.ok) throw new Error('Failed to load throttle settings');
  return res.json();
}

export async function setThrottle(
  payload: { preset: string } | { enabled: boolean; downKbps?: number; upKbps?: number; latencyMs?: number },
): Promise<ThrottleState['settings']> {
  const res = await fetch('/api/throttle', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update throttle');
  return (await res.json()).settings;
}
```

- [ ] **Step 2: Add the control**

In `src/ui/components/Controls.tsx`, add a preset `<select>` beside the existing controls. Load current state on mount, write on change, and show the active rate as a label. Match the existing Tailwind class conventions in that file:

```tsx
const [throttle, setThrottleState] = useState<ThrottleState | null>(null);

useEffect(() => {
  getThrottle().then(setThrottleState).catch(() => setThrottleState(null));
}, []);

async function onPresetChange(preset: string) {
  const settings = await setThrottle({ preset });
  setThrottleState((prev) => (prev ? { ...prev, settings } : prev));
}
```

Render an `off` option plus one option per preset key, with `value` selected from
`throttle.settings.enabled` and the matching preset rates.

- [ ] **Step 3: Verify in the browser**

```bash
npm run build && node dist/cli/index.js start
```
Open the UI, pick `3g`, confirm the label updates, then confirm
`node dist/cli/index.js throttle --status` reports 780/330/100 — proving CLI and UI share one source of truth.

- [ ] **Step 4: Commit**

```bash
git add src/ui/client.ts src/ui/components/Controls.tsx
git commit -m "feat: add throttle control to web UI"
```

---

## Phase 3 — WebSocket capture

### Task 7: RFC 6455 frame decoder

Pure and I/O-free, so it tests exhaustively without sockets. This is the highest-risk correctness surface in the plan; test it hard.

**Files:**
- Create: `src/server/ws-frames.ts`
- Test: `src/server/ws-frames.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';
  export interface WsMessage { opcode: WsOpcode; payload: Buffer; }
  export class WsFrameDecoder {
    push(chunk: Buffer): WsMessage[];
    get isFailed(): boolean;
  }
  export function encodeFrame(opcode: WsOpcode, payload: Buffer, mask?: boolean): Buffer;
  ```
  `encodeFrame` exists so tests and `ws-replay.ts` can build valid frames; the proxy relay never encodes.

- [ ] **Step 1: Write the failing tests**

Create `src/server/ws-frames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WsFrameDecoder, encodeFrame } from './ws-frames.js';

describe('WsFrameDecoder', () => {
  it('decodes a single unmasked text frame', () => {
    const d = new WsFrameDecoder();
    const out = d.push(encodeFrame('text', Buffer.from('hello')));
    expect(out).toHaveLength(1);
    expect(out[0].opcode).toBe('text');
    expect(out[0].payload.toString()).toBe('hello');
  });

  it('decodes a masked client frame', () => {
    const d = new WsFrameDecoder();
    const out = d.push(encodeFrame('text', Buffer.from('masked!'), true));
    expect(out[0].payload.toString()).toBe('masked!');
  });

  it('decodes a 16-bit length payload', () => {
    const payload = Buffer.alloc(300, 'a');
    const out = new WsFrameDecoder().push(encodeFrame('binary', payload));
    expect(out[0].payload.length).toBe(300);
    expect(out[0].opcode).toBe('binary');
  });

  it('decodes a 64-bit length payload', () => {
    const payload = Buffer.alloc(70_000, 'b');
    const out = new WsFrameDecoder().push(encodeFrame('binary', payload));
    expect(out[0].payload.length).toBe(70_000);
  });

  it('reassembles continuation frames into one message', () => {
    const d = new WsFrameDecoder();
    // fin=0 text, then fin=0 continuation, then fin=1 continuation
    const first = Buffer.concat([Buffer.from([0x01, 0x03]), Buffer.from('abc')]);
    const middle = Buffer.concat([Buffer.from([0x00, 0x03]), Buffer.from('def')]);
    const last = Buffer.concat([Buffer.from([0x80, 0x03]), Buffer.from('ghi')]);
    expect(d.push(first)).toHaveLength(0);
    expect(d.push(middle)).toHaveLength(0);
    const out = d.push(last);
    expect(out).toHaveLength(1);
    expect(out[0].payload.toString()).toBe('abcdefghi');
    expect(out[0].opcode).toBe('text');
  });

  it('decodes multiple frames arriving in one chunk', () => {
    const d = new WsFrameDecoder();
    const out = d.push(Buffer.concat([
      encodeFrame('text', Buffer.from('one')),
      encodeFrame('text', Buffer.from('two')),
    ]));
    expect(out.map((m) => m.payload.toString())).toEqual(['one', 'two']);
  });

  it('waits for the rest of a frame split across chunks', () => {
    const d = new WsFrameDecoder();
    const frame = encodeFrame('text', Buffer.from('split-me'));
    expect(d.push(frame.subarray(0, 3))).toHaveLength(0);
    const out = d.push(frame.subarray(3));
    expect(out[0].payload.toString()).toBe('split-me');
  });

  it('decodes control frames', () => {
    const d = new WsFrameDecoder();
    expect(d.push(encodeFrame('ping', Buffer.alloc(0)))[0].opcode).toBe('ping');
    expect(d.push(encodeFrame('pong', Buffer.alloc(0)))[0].opcode).toBe('pong');
    expect(d.push(encodeFrame('close', Buffer.alloc(0)))[0].opcode).toBe('close');
  });

  it('does not let a control frame interrupt fragment reassembly', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.concat([Buffer.from([0x01, 0x03]), Buffer.from('abc')]));
    const ping = d.push(encodeFrame('ping', Buffer.alloc(0)));
    expect(ping).toHaveLength(1);
    expect(ping[0].opcode).toBe('ping');
    const out = d.push(Buffer.concat([Buffer.from([0x80, 0x03]), Buffer.from('def')]));
    expect(out[0].payload.toString()).toBe('abcdef');
  });

  it('fails on a reserved opcode and stops decoding', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.from([0x83, 0x00])); // opcode 0x3 is reserved
    expect(d.isFailed).toBe(true);
    expect(d.push(encodeFrame('text', Buffer.from('x')))).toHaveLength(0);
  });

  it('fails on an oversized control frame', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.concat([Buffer.from([0x89, 0x7e, 0x01, 0x00]), Buffer.alloc(256)]));
    expect(d.isFailed).toBe(true);
  });

  it('fails on a fragmented control frame', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.from([0x09, 0x00])); // ping with fin=0
    expect(d.isFailed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/ws-frames.test.ts`
Expected: FAIL — `Failed to resolve import "./ws-frames.js"`

- [ ] **Step 3: Implement the decoder**

Create `src/server/ws-frames.ts`:

```ts
export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

export interface WsMessage {
  opcode: WsOpcode;
  payload: Buffer;
}

const OPCODES: Record<number, WsOpcode> = {
  0x1: 'text',
  0x2: 'binary',
  0x8: 'close',
  0x9: 'ping',
  0xa: 'pong',
};

const OPCODE_BYTES: Record<WsOpcode, number> = {
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

const CONTINUATION = 0x0;

/**
 * Incremental RFC 6455 frame decoder. Passive: it observes bytes and never
 * re-encodes them, so a decoding failure degrades recording without ever
 * corrupting relayed traffic.
 */
export class WsFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: WsOpcode | null = null;
  private failed = false;

  get isFailed(): boolean {
    return this.failed;
  }

  push(chunk: Buffer): WsMessage[] {
    if (this.failed) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const messages: WsMessage[] = [];
    for (;;) {
      const frame = this.readFrame();
      if (frame === 'incomplete') break;
      if (frame === 'invalid') {
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentOpcode = null;
        return messages;
      }
      if (frame.message) messages.push(frame.message);
    }
    return messages;
  }

  private readFrame(): 'incomplete' | 'invalid' | { message: WsMessage | null } {
    const buf = this.buffer;
    if (buf.length < 2) return 'incomplete';

    const fin = (buf[0] & 0x80) !== 0;
    const rawOpcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    const lenBits = buf[1] & 0x7f;

    let offset = 2;
    let payloadLength: number;
    if (lenBits < 126) {
      payloadLength = lenBits;
    } else if (lenBits === 126) {
      if (buf.length < offset + 2) return 'incomplete';
      payloadLength = buf.readUInt16BE(offset);
      offset += 2;
    } else {
      if (buf.length < offset + 8) return 'incomplete';
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return 'invalid';
      payloadLength = Number(big);
      offset += 8;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return 'incomplete';
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLength) return 'incomplete';

    let payload = Buffer.from(buf.subarray(offset, offset + payloadLength));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    this.buffer = buf.subarray(offset + payloadLength);

    const isControl = rawOpcode >= 0x8;
    if (isControl) {
      // Control frames are never fragmented and cap at 125 bytes.
      if (!fin || payloadLength > 125) return 'invalid';
      const opcode = OPCODES[rawOpcode];
      if (!opcode) return 'invalid';
      return { message: { opcode, payload } };
    }

    if (rawOpcode === CONTINUATION) {
      if (this.fragmentOpcode === null) return 'invalid';
      this.fragments.push(payload);
      if (!fin) return { message: null };
      const full = Buffer.concat(this.fragments);
      const opcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = null;
      return { message: { opcode, payload: full } };
    }

    const opcode = OPCODES[rawOpcode];
    if (!opcode) return 'invalid';
    if (this.fragmentOpcode !== null) return 'invalid'; // interleaved data frame
    if (fin) return { message: { opcode, payload } };

    this.fragmentOpcode = opcode;
    this.fragments = [payload];
    return { message: null };
  }
}

/** Build a valid frame. Used by tests and by WebSocket replay, never by the relay. */
export function encodeFrame(opcode: WsOpcode, payload: Buffer, mask = false): Buffer {
  const header: number[] = [0x80 | OPCODE_BYTES[opcode]];
  const maskBit = mask ? 0x80 : 0x00;

  if (payload.length < 126) {
    header.push(maskBit | payload.length);
  } else if (payload.length < 65536) {
    header.push(maskBit | 126, payload.length >> 8, payload.length & 0xff);
  } else {
    header.push(maskBit | 127);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    header.push(...len);
  }

  if (!mask) return Buffer.concat([Buffer.from(header), payload]);

  const key = Buffer.from([
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
  ]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(header), key, masked]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/ws-frames.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/ws-frames.ts src/server/ws-frames.test.ts
git commit -m "feat: add RFC 6455 WebSocket frame decoder"
```

---

### Task 8: WebSocket message storage and schema migration

**Files:**
- Modify: `src/storage/db.ts`, `src/shared/types.ts`
- Test: `src/storage/db.test.ts` (add cases)

**Interfaces:**
- Produces:
  ```ts
  export type RequestKind = 'http' | 'websocket';
  export interface WebSocketMessage {
    id: string;
    request_id: string;
    timestamp: number;
    direction: 'sent' | 'received';   // sent = client→server
    opcode: WsOpcode;
    payload: Buffer | null;
    size: number;
    truncated: number;
  }
  ```
  `RequestRecord` gains optional `kind?: RequestKind`. `Database` gains
  `insertWebSocketMessages(messages: WebSocketMessage[]): void` and
  `getWebSocketMessages(requestId: string, limit?: number, offset?: number): PaginatedResponse<WebSocketMessage>`.

  `kind` is optional on `RequestRecord` so existing record literals and tests keep
  compiling; the insert binding defaults it to `'http'`.

- [ ] **Step 1: Write the failing tests**

Add to `src/storage/db.test.ts`:

```ts
  it('stores and retrieves websocket messages in timestamp order', () => {
    db.insert({ ...baseRecord(), id: 'conn-1', kind: 'websocket', status: 101 });
    db.insertWebSocketMessages([
      { id: 'm2', request_id: 'conn-1', timestamp: 2000, direction: 'received',
        opcode: 'text', payload: Buffer.from('pong'), size: 4, truncated: 0 },
      { id: 'm1', request_id: 'conn-1', timestamp: 1000, direction: 'sent',
        opcode: 'text', payload: Buffer.from('ping'), size: 4, truncated: 0 },
    ]);

    const result = db.getWebSocketMessages('conn-1');
    expect(result.total).toBe(2);
    expect(result.data.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(result.data[0].direction).toBe('sent');
    expect(Buffer.from(result.data[0].payload!).toString()).toBe('ping');
  });

  it('scopes messages to their connection', () => {
    db.insert({ ...baseRecord(), id: 'conn-a', kind: 'websocket' });
    db.insert({ ...baseRecord(), id: 'conn-b', kind: 'websocket' });
    db.insertWebSocketMessages([
      { id: 'x', request_id: 'conn-a', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
    ]);
    expect(db.getWebSocketMessages('conn-b').total).toBe(0);
  });

  it('paginates messages', () => {
    db.insert({ ...baseRecord(), id: 'conn-p', kind: 'websocket' });
    db.insertWebSocketMessages(
      Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`, request_id: 'conn-p', timestamp: i, direction: 'sent' as const,
        opcode: 'text' as const, payload: Buffer.from(String(i)), size: 1, truncated: 0,
      })),
    );
    const page = db.getWebSocketMessages('conn-p', 2, 2);
    expect(page.total).toBe(5);
    expect(page.data.map((m) => m.id)).toEqual(['p2', 'p3']);
  });

  it('defaults kind to http for records that omit it', () => {
    db.insert({ ...baseRecord(), id: 'plain' });
    expect((db.getById('plain') as { kind?: string }).kind).toBe('http');
  });

  it('migrates a database created without the kind column', () => {
    const legacyPath = path.join(tmpDir, 'legacy.db');
    const legacy = new BetterSqlite3(legacyPath);
    legacy.exec(`
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, method TEXT NOT NULL,
        url TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, protocol TEXT NOT NULL,
        request_headers TEXT, request_body BLOB, request_size INTEGER, status INTEGER,
        response_headers TEXT, response_body BLOB, response_size INTEGER,
        duration INTEGER, content_type TEXT, truncated INTEGER DEFAULT 0
      );
    `);
    legacy.prepare(
      `INSERT INTO requests (id, timestamp, method, url, host, path, protocol)
       VALUES ('old', 1, 'GET', 'http://x/', 'x', '/', 'http')`,
    ).run();
    legacy.close();

    const migrated = new Database(legacyPath);
    expect((migrated.getById('old') as { kind?: string }).kind).toBe('http');
    migrated.insert({ ...baseRecord(), id: 'new', kind: 'websocket' });
    expect((migrated.getById('new') as { kind?: string }).kind).toBe('websocket');
    migrated.close();
  });
```

Add `import BetterSqlite3 from 'better-sqlite3';` and `import path from 'node:path';` to the test file if absent, and add a `baseRecord()` helper returning a complete valid `RequestRecord` if the file does not already have one.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/storage/db.test.ts`
Expected: FAIL — `db.insertWebSocketMessages is not a function`

- [ ] **Step 3: Add the types**

Append to `src/shared/types.ts`:

```ts
export type RequestKind = 'http' | 'websocket';

export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

export interface WebSocketMessage {
  id: string;
  request_id: string;
  timestamp: number;
  /** 'sent' = client→server, 'received' = server→client */
  direction: 'sent' | 'received';
  opcode: WsOpcode;
  payload: Buffer | null;
  size: number;
  truncated: number;
}
```

Add `kind?: RequestKind;` to `RequestRecord`.

Re-export the opcode type from `src/server/ws-frames.ts` instead of redeclaring it there: change `ws-frames.ts` to `import type { WsOpcode } from '../shared/types.js';` and `export type { WsOpcode };` so there is exactly one definition.

- [ ] **Step 4: Extend the schema and add the migration**

In `src/storage/db.ts` `init()`, add `kind TEXT DEFAULT 'http'` to the `requests` CREATE TABLE (after `truncated`), append the new table, then run the guarded migration:

```ts
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        ... existing columns ...,
        truncated INTEGER DEFAULT 0,
        kind TEXT DEFAULT 'http'
      );
      ... existing indexes ...
      CREATE TABLE IF NOT EXISTS websocket_messages (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        opcode TEXT NOT NULL,
        payload BLOB,
        size INTEGER NOT NULL,
        truncated INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ws_request_id ON websocket_messages(request_id);
      CREATE INDEX IF NOT EXISTS idx_ws_timestamp ON websocket_messages(timestamp);
    `);
    this.migrate();
  }

  /** Add columns introduced after the original schema shipped. */
  private migrate(): void {
    const columns = this.db.pragma('table_info(requests)') as { name: string }[];
    if (!columns.some((c) => c.name === 'kind')) {
      this.db.exec(`ALTER TABLE requests ADD COLUMN kind TEXT DEFAULT 'http'`);
    }
  }
```

- [ ] **Step 5: Bind `kind` on insert and add the message methods**

In both `insert` and `insertBatch`, add `kind` to the column list and `@kind` to the
values list, and bind through a normaliser so records that omit it default correctly:

```ts
  private bindRecord(record: RequestRecord): Record<string, unknown> {
    return { ...record, kind: record.kind ?? 'http' };
  }
```
Call `stmt.run(this.bindRecord(record))` in `insert`, and the same inside
`insertBatch`'s transaction loop.

Then add:

```ts
  insertWebSocketMessages(messages: WebSocketMessage[]): void {
    if (messages.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO websocket_messages (
        id, request_id, timestamp, direction, opcode, payload, size, truncated
      ) VALUES (
        @id, @request_id, @timestamp, @direction, @opcode, @payload, @size, @truncated
      )
    `);
    const insertMany = this.db.transaction((rows: WebSocketMessage[]) => {
      for (const row of rows) stmt.run(row);
    });
    insertMany(messages);
  }

  getWebSocketMessages(
    requestId: string,
    limit = 500,
    offset = 0,
  ): PaginatedResponse<WebSocketMessage> {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM websocket_messages WHERE request_id = ?')
        .get(requestId) as { count: number }
    ).count;
    const data = this.db
      .prepare(
        `SELECT * FROM websocket_messages WHERE request_id = @requestId
         ORDER BY timestamp ASC LIMIT @limit OFFSET @offset`,
      )
      .all({ requestId, limit, offset }) as WebSocketMessage[];
    return { data, total, limit, offset };
  }
```

Also extend `deleteAll` to clear the new table: `this.db.exec('DELETE FROM websocket_messages');` before the existing `DELETE FROM requests`, and add a matching delete to `deleteOlderThan`/`deleteOldest` so orphaned messages do not accumulate:

```ts
  deleteOlderThan(timestampMs: number): number {
    this.db
      .prepare(
        `DELETE FROM websocket_messages WHERE request_id IN
         (SELECT id FROM requests WHERE timestamp < ?)`,
      )
      .run(timestampMs);
    return this.db.prepare('DELETE FROM requests WHERE timestamp < ?').run(timestampMs).changes;
  }
```
Apply the equivalent subquery cleanup inside `deleteOldest`.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/storage/db.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/storage/db.ts src/storage/db.test.ts src/shared/types.ts src/server/ws-frames.ts
git commit -m "feat: add websocket message storage with kind column migration"
```

---

### Task 9: WebSocket relay and proxy wiring

**Files:**
- Create: `src/server/websocket.ts`
- Modify: `src/server/proxy.ts`
- Test: `tests/integration/websocket.integration.test.ts`

**Interfaces:**
- Consumes: `WsFrameDecoder` (T7), `insertWebSocketMessages` (T8), `ExchangeTarget` (T1), `Throttler` (T2)
- Produces:
  ```ts
  export interface WebSocketDeps {
    config: Config;
    onRecord: (record: RequestRecord) => void;
    onMessages: (messages: WebSocketMessage[]) => void;
    throttle?: Throttler;
  }
  export function handleWebSocketUpgrade(
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
    target: ExchangeTarget,
    deps: WebSocketDeps,
  ): void;
  ```

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/websocket.integration.test.ts`. It stands up a minimal
RFC 6455 server using `encodeFrame` and the decoder, so no `ws` dependency is needed:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { LaurelProxyServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';
import { Database } from '../../src/storage/db.js';
import { WsFrameDecoder, encodeFrame } from '../../src/server/ws-frames.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Minimal echo WebSocket server: accepts the handshake, echoes text frames. */
function startEchoServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const decoder = new WsFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.opcode === 'text') {
          socket.write(encodeFrame('text', Buffer.from(`echo:${msg.payload.toString()}`)));
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

describe('websocket capture', () => {
  let proxyServer: LaurelProxyServer;
  let echo: { server: http.Server; port: number };
  let proxyPort: number;
  let dbPath: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-ws-'));
    dbPath = path.join(tmpDir, 'data.db');
    echo = await startEchoServer();
    const config = loadConfig({ dbPath, proxyPort: 0, uiPort: 0 });
    proxyServer = new LaurelProxyServer(config);
    const ports = await proxyServer.start();
    proxyPort = ports.proxyPort;
  }, 30_000);

  afterAll(async () => {
    await proxyServer.stop();
    echo.server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('relays frames intact and records them', async () => {
    const received: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${echo.port}/socket`,
        headers: {
          host: `127.0.0.1:${echo.port}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (_res, socket, head) => {
        const decoder = new WsFrameDecoder();
        if (head.length) {
          for (const m of decoder.push(head)) received.push(m.payload.toString());
        }
        socket.on('data', (chunk: Buffer) => {
          for (const m of decoder.push(chunk)) {
            received.push(m.payload.toString());
            if (received.length === 2) {
              socket.end();
              resolve();
            }
          }
        });
        socket.write(encodeFrame('text', Buffer.from('hello'), true));
        socket.write(encodeFrame('text', Buffer.from('world'), true));
      });

      req.on('error', reject);
      req.end();
    });

    // Traffic fidelity: payloads round-trip byte-identical.
    expect(received).toEqual(['echo:hello', 'echo:world']);

    // Give the 100ms batch write queue time to flush.
    await new Promise((r) => setTimeout(r, 400));

    const db = new Database(dbPath);
    const conns = db.query({ limit: 100 }).data.filter((r) => r.kind === 'websocket');
    expect(conns).toHaveLength(1);
    expect(conns[0].status).toBe(101);

    const messages = db.getWebSocketMessages(conns[0].id);
    const sent = messages.data.filter((m) => m.direction === 'sent');
    const back = messages.data.filter((m) => m.direction === 'received');
    expect(sent.map((m) => Buffer.from(m.payload!).toString())).toEqual(['hello', 'world']);
    expect(back.map((m) => Buffer.from(m.payload!).toString())).toEqual(['echo:hello', 'echo:world']);
    db.close();
  }, 20_000);

  it('records a refused upgrade as an ordinary request', async () => {
    const plain = http.createServer((_req, res) => { res.writeHead(426); res.end('Upgrade Required'); });
    await new Promise<void>((r) => plain.listen(0, r));
    const plainPort = (plain.address() as net.AddressInfo).port;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${plainPort}/nope`,
        headers: {
          host: `127.0.0.1:${plainPort}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(426);
    plain.close();
  }, 20_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/websocket.integration.test.ts`
Expected: FAIL — the upgrade is never answered, so the request times out or errors

- [ ] **Step 3: Implement the relay**

Create `src/server/websocket.ts`:

```ts
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WsFrameDecoder } from './ws-frames.js';
import type { ExchangeTarget } from './exchange.js';
import type { Throttler, RateLimiter } from './throttle.js';
import type { Config, RequestRecord, WebSocketMessage } from '../shared/types.js';

export interface WebSocketDeps {
  config: Config;
  onRecord: (record: RequestRecord) => void;
  onMessages: (messages: WebSocketMessage[]) => void;
  throttle?: Throttler;
}

export function handleWebSocketUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  target: ExchangeTarget,
  deps: WebSocketDeps,
): void {
  const id = randomUUID();
  const startTime = Date.now();
  const { config } = deps;

  const upstreamHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
  delete upstreamHeaders['proxy-connection'];
  delete upstreamHeaders['proxy-authorization'];
  // Suppress permessage-deflate so every relayed frame stays readable.
  delete upstreamHeaders['sec-websocket-extensions'];
  if (target.protocol === 'https') upstreamHeaders.host = target.hostname;

  const transport = target.protocol === 'https' ? https : http;
  const upstreamReq = transport.request({
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: clientReq.method,
    headers: upstreamHeaders,
    ...(target.protocol === 'https' ? { rejectUnauthorized: false } : {}),
  });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead: Buffer) => {
    // Replay the 101 verbatim so the client sees the server's own handshake.
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);

    deps.onRecord({
      id,
      timestamp: startTime,
      method: clientReq.method || 'GET',
      url: target.url,
      host: target.hostname,
      path: target.path.split('?')[0] || '/',
      protocol: target.protocol,
      kind: 'websocket',
      request_headers: JSON.stringify(clientReq.headers),
      request_body: null,
      request_size: 0,
      status: upstreamRes.statusCode ?? 101,
      response_headers: JSON.stringify(upstreamRes.headers),
      response_body: null,
      response_size: 0,
      duration: Date.now() - startTime,
      content_type: 'websocket',
      truncated: 0,
    });

    const observe = makeObserver(id, config, deps.onMessages);

    // Bytes captured with the handshake belong to the stream; relay them first.
    if (upstreamHead?.length) {
      observe('received', upstreamHead);
      clientSocket.write(upstreamHead);
    }
    if (head?.length) {
      observe('sent', head);
      upstreamSocket.write(head);
    }

    void pump(clientSocket, upstreamSocket, (c) => observe('sent', c), deps.throttle?.up);
    void pump(upstreamSocket, clientSocket, (c) => observe('received', c), deps.throttle?.down);
  });

  // Upstream refused the upgrade: relay its response and record it normally.
  upstreamReq.on('response', (upstreamRes) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);

    const chunks: Buffer[] = [];
    let size = 0;
    upstreamRes.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= config.maxBodySize) chunks.push(chunk);
      clientSocket.write(chunk);
    });
    upstreamRes.on('end', () => {
      clientSocket.end();
      const body = Buffer.concat(chunks);
      deps.onRecord({
        id,
        timestamp: startTime,
        method: clientReq.method || 'GET',
        url: target.url,
        host: target.hostname,
        path: target.path.split('?')[0] || '/',
        protocol: target.protocol,
        kind: 'http',
        request_headers: JSON.stringify(clientReq.headers),
        request_body: null,
        request_size: 0,
        status: upstreamRes.statusCode ?? 0,
        response_headers: JSON.stringify(upstreamRes.headers),
        response_body: body.length > 0 ? body : null,
        response_size: size,
        duration: Date.now() - startTime,
        content_type: (upstreamRes.headers['content-type'] || '').split(';')[0].trim() || null,
        truncated: size > config.maxBodySize ? 1 : 0,
      });
    });
  });

  upstreamReq.on('error', () => {
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    upstreamReq.destroy();
  });

  upstreamReq.end();
}

/**
 * Decodes frames for recording only. On a decode failure the connection keeps
 * relaying — traffic fidelity outranks recording completeness.
 */
function makeObserver(
  requestId: string,
  config: Config,
  onMessages: (messages: WebSocketMessage[]) => void,
): (direction: 'sent' | 'received', chunk: Buffer) => void {
  const decoders: Record<'sent' | 'received', WsFrameDecoder> = {
    sent: new WsFrameDecoder(),
    received: new WsFrameDecoder(),
  };

  return (direction, chunk) => {
    const decoder = decoders[direction];
    if (decoder.isFailed) return;
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      return;
    }
    if (frames.length === 0) return;
    onMessages(
      frames.map((frame) => ({
        id: randomUUID(),
        request_id: requestId,
        timestamp: Date.now(),
        direction,
        opcode: frame.opcode,
        payload:
          frame.payload.length > 0 ? frame.payload.subarray(0, config.maxBodySize) : null,
        size: frame.payload.length,
        truncated: frame.payload.length > config.maxBodySize ? 1 : 0,
      })),
    );
  };
}

/** Relay one direction, observing bytes and honouring backpressure. */
async function pump(
  from: net.Socket,
  to: net.Socket,
  observe: (chunk: Buffer) => void,
  limiter?: RateLimiter,
): Promise<void> {
  try {
    for await (const chunk of from as AsyncIterable<Buffer>) {
      observe(chunk);
      await limiter?.consume(chunk.length);
      if (!to.write(chunk)) await once(to, 'drain');
    }
  } catch {
    // Either side may vanish; teardown below is unconditional.
  }
  to.end();
}
```

- [ ] **Step 4: Wire the upgrade dispatch into proxy.ts**

In `src/server/proxy.ts`, add the import:

```ts
import { handleWebSocketUpgrade } from './websocket.js';
import type { WebSocketDeps } from './websocket.js';
```

Add a deps accessor beside `exchangeDeps`:

```ts
  private get webSocketDeps(): WebSocketDeps {
    return {
      config: this.config,
      onRecord: (record) => {
        this.writeQueue.push(record);
        this.events.push(record);
      },
      onMessages: (messages) => {
        this.wsWriteQueue.push(...messages);
        this.events.pushWsMessages(messages);
      },
      throttle: this.throttler ?? undefined,
    };
  }
```

Add the queue field and flush it alongside requests. `WebSocketMessage` must be added
to the existing type import from `../shared/types.js` at the top of `proxy.ts`:

```ts
import type { Config, RequestRecord, WebSocketMessage } from '../shared/types.js';
```
```ts
  private wsWriteQueue: WebSocketMessage[] = [];
```
```ts
  private flushWrites(): void {
    if (this.writeQueue.length > 0) {
      const batch = this.writeQueue;
      this.writeQueue = [];
      this.db.insertBatch(batch);
    }
    if (this.wsWriteQueue.length > 0) {
      const batch = this.wsWriteQueue;
      this.wsWriteQueue = [];
      this.db.insertWebSocketMessages(batch);
    }
  }
```

Register the listener in `start()`, next to the existing `connect` listener:

```ts
    this.server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      const target = resolveHttpTarget(req.url || '/');
      if (!target) {
        socket.destroy();
        return;
      }
      handleWebSocketUpgrade(req, socket, head, target, this.webSocketDeps);
    });
```

And inside `handleConnect`, register the same on the virtual server so `wss://` works:

```ts
      virtualServer.on('upgrade', (clientReq, socket: net.Socket, upgradeHead: Buffer) => {
        const target = resolveMitmTarget(hostname, port, clientReq.url || '/');
        handleWebSocketUpgrade(clientReq, socket, upgradeHead, target, this.webSocketDeps);
      });
```

`events.pushWsMessages` does not exist yet — add a temporary no-op to `EventManager`
now and implement it properly in Task 10:

```ts
  pushWsMessages(_messages: WebSocketMessage[]): void {}
```

- [ ] **Step 5: Run the integration test**

Run: `npx vitest run tests/integration/websocket.integration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/websocket.ts src/server/proxy.ts src/server/events.ts tests/integration/websocket.integration.test.ts
git commit -m "feat: capture WebSocket traffic through the proxy"
```

---

### Task 10: WebSocket message API and live events

**Files:**
- Modify: `src/server/events.ts`, `src/server/api.ts`
- Test: `src/server/events.test.ts`, `src/server/api.test.ts` (add cases)

**Interfaces:**
- Produces: `EventManager.pushWsMessages(messages: WebSocketMessage[]): void`,
  `EventManager.subscribeWsMessages(fn: (messages: WebSocketMessage[]) => void): () => void`;
  `GET /api/requests/:id/messages?limit&offset` → `PaginatedResponse<WebSocketMessage>` with base64 payloads;
  SSE `ws-message` event

- [ ] **Step 1: Write the failing tests**

Add to `src/server/events.test.ts`:

```ts
  it('delivers websocket messages to subscribers', () => {
    const events = new EventManager();
    const seen: WebSocketMessage[][] = [];
    events.subscribeWsMessages((batch) => seen.push(batch));
    events.pushWsMessages([
      { id: 'w1', request_id: 'c1', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('hi'), size: 2, truncated: 0 },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0][0].id).toBe('w1');
  });

  it('stops delivering after unsubscribe', () => {
    const events = new EventManager();
    const seen: unknown[] = [];
    const unsub = events.subscribeWsMessages((b) => seen.push(b));
    unsub();
    events.pushWsMessages([
      { id: 'w2', request_id: 'c1', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: null, size: 0, truncated: 0 },
    ]);
    expect(seen).toHaveLength(0);
  });
```

Add to `src/server/api.test.ts`:

```ts
  it('GET /api/requests/:id/messages returns base64 payloads', async () => {
    db.insert({ ...baseRecord(), id: 'ws-1', kind: 'websocket', status: 101 });
    db.insertWebSocketMessages([
      { id: 'm1', request_id: 'ws-1', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('hello'), size: 5, truncated: 0 },
    ]);
    const res = await request('GET', '/api/requests/ws-1/messages');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(Buffer.from(res.body.data[0].payload, 'base64').toString()).toBe('hello');
  });

  it('GET /api/requests/:id/messages returns an empty page for unknown ids', async () => {
    const res = await request('GET', '/api/requests/nope/messages');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/events.test.ts src/server/api.test.ts`
Expected: FAIL — `subscribeWsMessages` missing; 404 on the messages route

- [ ] **Step 3: Implement the event channel**

In `src/server/events.ts`, replace the Task 9 no-op with a real implementation
mirroring the existing request buffering:

```ts
import type { RequestRecord, WebSocketMessage } from '../shared/types.js';

type WsMessageSubscriber = (messages: WebSocketMessage[]) => void;
```
```ts
  private wsSubscribers: Set<WsMessageSubscriber> = new Set();

  pushWsMessages(messages: WebSocketMessage[]): void {
    if (messages.length === 0) return;
    for (const sub of this.wsSubscribers) {
      try { sub(messages); } catch {}
    }
  }

  subscribeWsMessages(fn: WsMessageSubscriber): () => void {
    this.wsSubscribers.add(fn);
    return () => { this.wsSubscribers.delete(fn); };
  }
```
In `stop()`, add `this.wsSubscribers.clear();`.

- [ ] **Step 4: Add the endpoint and SSE channel**

In `src/server/api.ts`, add a serializer and the route:

```ts
function serializeWsMessage(m: WebSocketMessage): Record<string, unknown> {
  return {
    ...m,
    payload: m.payload ? Buffer.from(m.payload).toString('base64') : null,
  };
}
```
```ts
  router.get('/requests/:id/messages', (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const result = db.getWebSocketMessages(req.params.id as string, limit, offset);
    res.json({ ...result, data: result.data.map(serializeWsMessage) });
  });
```

Extend the `/events` handler to forward the new channel:

```ts
    const unsubWs = events.subscribeWsMessages((messages) => {
      for (const message of messages) {
        res.write(`event: ws-message\nid: ${message.id}\ndata: ${JSON.stringify(serializeWsMessage(message))}\n\n`);
      }
    });
```
and add `unsubWs();` to the `req.on('close', ...)` cleanup.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/server/events.test.ts src/server/api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/events.ts src/server/events.test.ts src/server/api.ts src/server/api.test.ts
git commit -m "feat: expose websocket messages via REST and SSE"
```

---

### Task 11: `laurel-proxy messages` command

**Files:**
- Create: `src/cli/commands/messages.ts`
- Modify: `src/cli/index.ts`, `src/cli/format.ts`
- Test: `src/cli/format.test.ts` (add cases)

**Interfaces:**
- Consumes: `GET /api/requests/:id/messages`, SSE `ws-message`
- Produces: `registerMessages(program: Command): void`;
  `formatWsMessages(result: PaginatedResponse<WebSocketMessage>, format: string): string`;
  `formatWsMessageLine(message: WebSocketMessage, format: string): string`

- [ ] **Step 1: Write the failing formatter tests**

Add to `src/cli/format.test.ts`:

```ts
import { formatWsMessages, formatWsMessageLine } from './format.js';

const wsMessage = (over: Partial<WebSocketMessage> = {}): WebSocketMessage => ({
  id: 'm1', request_id: 'c1', timestamp: 1735689600000, direction: 'sent',
  opcode: 'text', payload: Buffer.from('{"op":1}'), size: 8, truncated: 0, ...over,
});

describe('formatWsMessages', () => {
  it('renders direction arrows in table format', () => {
    const out = formatWsMessages(
      { data: [wsMessage(), wsMessage({ id: 'm2', direction: 'received' })], total: 2, limit: 500, offset: 0 },
      'table',
    );
    expect(out).toContain('→');
    expect(out).toContain('←');
  });

  it('emits parseable JSON with decoded text payloads', () => {
    const out = formatWsMessages(
      { data: [wsMessage()], total: 1, limit: 500, offset: 0 },
      'json',
    );
    expect(JSON.parse(out).data[0].payload).toBe('{"op":1}');
  });

  it('reports an empty connection', () => {
    const out = formatWsMessages({ data: [], total: 0, limit: 500, offset: 0 }, 'table');
    expect(out).toContain('No messages');
  });

  it('marks binary payloads by size rather than dumping bytes', () => {
    const out = formatWsMessages(
      { data: [wsMessage({ opcode: 'binary', payload: Buffer.alloc(64), size: 64 })], total: 1, limit: 500, offset: 0 },
      'table',
    );
    expect(out).toContain('binary');
    expect(out).toContain('64');
  });
});

describe('formatWsMessageLine', () => {
  it('renders one line per message for streaming', () => {
    expect(formatWsMessageLine(wsMessage(), 'agent')).toContain('{"op":1}');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/cli/format.test.ts`
Expected: FAIL — `formatWsMessages` is not exported

- [ ] **Step 3: Add the formatters**

Append to `src/cli/format.ts`, matching the existing `COL`/padding helpers:

```ts
function wsPayloadPreview(message: WebSocketMessage, maxLength = 120): string {
  if (!message.payload) return '';
  const buf = Buffer.from(message.payload);
  if (message.opcode === 'binary') return `<${message.size} bytes>`;
  const text = buf.toString('utf8');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function formatWsMessages(
  result: PaginatedResponse<WebSocketMessage>,
  format: string,
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        ...result,
        data: result.data.map((m) => ({
          ...m,
          payload: m.payload
            ? m.opcode === 'binary'
              ? Buffer.from(m.payload).toString('base64')
              : Buffer.from(m.payload).toString('utf8')
            : null,
        })),
      },
      null,
      2,
    );
  }

  if (result.data.length === 0) return 'No messages captured for this connection.';

  const lines = result.data.map((m) => {
    const arrow = m.direction === 'sent' ? '→' : '←';
    const time = new Date(m.timestamp).toISOString().slice(11, 23);
    const opcode = m.opcode.padEnd(6);
    const size = String(m.size).padStart(7);
    return `${time}  ${arrow}  ${opcode} ${size}  ${wsPayloadPreview(m)}`;
  });

  return [
    `${result.total} message${result.total === 1 ? '' : 's'}  (→ client→server, ← server→client)`,
    '',
    ...lines,
  ].join('\n');
}

export function formatWsMessageLine(message: WebSocketMessage, format: string): string {
  if (format === 'json' || format === 'agent') {
    return JSON.stringify({
      direction: message.direction,
      opcode: message.opcode,
      size: message.size,
      timestamp: message.timestamp,
      payload: wsPayloadPreview(message, 500),
    });
  }
  const arrow = message.direction === 'sent' ? '→' : '←';
  return `${arrow} ${message.opcode} ${message.size}B ${wsPayloadPreview(message)}`;
}
```
Add `WebSocketMessage` to the type import from `../shared/types.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/cli/format.test.ts`
Expected: PASS

- [ ] **Step 5: Create the command**

Create `src/cli/commands/messages.ts`:

```ts
import type { Command } from 'commander';
import http from 'node:http';
import { Database } from '../../storage/db.js';
import { loadConfig } from '../../server/config.js';
import { formatWsMessages, formatWsMessageLine } from '../format.js';
import type { WebSocketMessage } from '../../shared/types.js';

/** Stream ws-message SSE events for one connection. */
function followMessages(port: number, requestId: string, format: string): void {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`Failed to connect to event stream (status ${res.statusCode}). Is the proxy running?`);
        process.exit(1);
      }
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          let eventType = '';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (eventType !== 'ws-message' || !data) continue;
          try {
            const raw = JSON.parse(data) as WebSocketMessage & { payload: string | null };
            if (raw.request_id !== requestId) continue;
            console.log(
              formatWsMessageLine(
                { ...raw, payload: raw.payload ? Buffer.from(raw.payload, 'base64') : null },
                format,
              ),
            );
          } catch {
            // Ignore malformed events
          }
        }
      });
      res.on('end', () => { console.error('Event stream closed.'); process.exit(0); });
    },
  );
  req.on('error', () => {
    console.error('Could not connect to proxy. Is it running?');
    process.exit(1);
  });
  req.end();
}

export function registerMessages(program: Command): void {
  program
    .command('messages <id>')
    .description('Show WebSocket frames captured for a connection')
    .option('--follow', 'Stream new frames as they arrive')
    .option('--limit <n>', 'Max frames to show', '500')
    .option('--format <format>', 'Output format (json|table|agent)', 'table')
    .option('--ui-port <number>', 'UI/API port for --follow', '8081')
    .option('--db-path <path>', 'Database path')
    .action((id: string, opts) => {
      const validFormats = ['json', 'table', 'agent'];
      if (!validFormats.includes(opts.format)) {
        console.error(`Invalid format "${opts.format}". Valid formats: ${validFormats.join(', ')}`);
        process.exit(1);
      }

      if (opts.follow) {
        followMessages(parseInt(opts.uiPort, 10), id, opts.format);
        return;
      }

      const config = loadConfig(opts.dbPath ? { dbPath: opts.dbPath } : {});
      const db = new Database(config.dbPath);
      const record = db.getById(id);
      if (!record) {
        console.error(`No request found with id ${id}`);
        db.close();
        process.exit(1);
      }
      const result = db.getWebSocketMessages(id, parseInt(opts.limit, 10), 0);
      console.log(formatWsMessages(result, opts.format));
      db.close();
    });
}
```

- [ ] **Step 6: Register it**

In `src/cli/index.ts`:

```ts
import { registerMessages } from './commands/messages.js';
```
```ts
registerMessages(program);
```

- [ ] **Step 7: Verify by hand against a real WebSocket**

```bash
npm run build
node dist/cli/index.js start &
sleep 3
# Drive traffic through the proxy to any public echo endpoint, then:
node dist/cli/index.js requests --format table   # find the kind=websocket row id
node dist/cli/index.js messages <that-id>
node dist/cli/index.js stop
```
Expected: frames listed with `→`/`←` arrows and readable text payloads.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/messages.ts src/cli/index.ts src/cli/format.ts src/cli/format.test.ts
git commit -m "feat: add laurel-proxy messages command"
```

---

### Task 12: WebSocket connection replay

**Files:**
- Create: `src/server/ws-replay.ts`
- Modify: `src/server/api.ts`, `src/shared/types.ts`
- Test: `src/server/ws-replay.test.ts`

**Interfaces:**
- Consumes: `encodeFrame` is *not* needed here — Node's `WebSocket` handles framing. Consumes `getWebSocketMessages` (T8).
- Produces:
  ```ts
  export interface WsReplayFrame { opcode: 'text' | 'binary'; payload: string; delayMs: number; }
  export interface WsReplayRequest { url: string; frames: WsReplayFrame[]; timeoutMs?: number; }
  export interface WsReplayResponse {
    sentCount: number;
    received: { opcode: 'text' | 'binary'; payload: string; offsetMs: number }[];
    durationMs: number;
    closeCode: number | null;
    error?: string;
  }
  export function replayWebSocket(request: WsReplayRequest): Promise<WsReplayResponse>;
  export function recordToWsReplayRequest(
    record: RequestRecord,
    messages: WebSocketMessage[],
  ): WsReplayRequest;
  ```
  `payload` fields are base64 in both directions, matching how `/api/requests/:id/messages` serialises.

- [ ] **Step 1: Write the failing tests**

Create `src/server/ws-replay.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { replayWebSocket, recordToWsReplayRequest } from './ws-replay.js';
import { WsFrameDecoder, encodeFrame } from './ws-frames.js';
import type { RequestRecord, WebSocketMessage } from '../shared/types.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function startEchoServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const decoder = new WsFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.opcode === 'text') {
          socket.write(encodeFrame('text', Buffer.from(`re:${msg.payload.toString()}`)));
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

describe('recordToWsReplayRequest', () => {
  it('keeps only client-sent data frames and derives relative delays', () => {
    const record = { url: 'https://example.com/socket' } as RequestRecord;
    const messages: WebSocketMessage[] = [
      { id: 'a', request_id: 'c', timestamp: 1000, direction: 'sent',
        opcode: 'text', payload: Buffer.from('one'), size: 3, truncated: 0 },
      { id: 'b', request_id: 'c', timestamp: 1200, direction: 'received',
        opcode: 'text', payload: Buffer.from('ignored'), size: 7, truncated: 0 },
      { id: 'c', request_id: 'c', timestamp: 1500, direction: 'sent',
        opcode: 'ping', payload: null, size: 0, truncated: 0 },
      { id: 'd', request_id: 'c', timestamp: 1800, direction: 'sent',
        opcode: 'text', payload: Buffer.from('two'), size: 3, truncated: 0 },
    ];

    const result = recordToWsReplayRequest(record, messages);
    expect(result.url).toBe('wss://example.com/socket');
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0].delayMs).toBe(0);
    expect(result.frames[1].delayMs).toBe(800);
    expect(Buffer.from(result.frames[1].payload, 'base64').toString()).toBe('two');
  });

  it('maps http urls to ws scheme', () => {
    const record = { url: 'http://example.com/s' } as RequestRecord;
    expect(recordToWsReplayRequest(record, []).url).toBe('ws://example.com/s');
  });
});

describe('replayWebSocket', () => {
  it('resends frames and collects replies', async () => {
    const echo = await startEchoServer();
    const result = await replayWebSocket({
      url: `ws://127.0.0.1:${echo.port}/s`,
      frames: [
        { opcode: 'text', payload: Buffer.from('alpha').toString('base64'), delayMs: 0 },
        { opcode: 'text', payload: Buffer.from('beta').toString('base64'), delayMs: 10 },
      ],
      timeoutMs: 3000,
    });

    expect(result.sentCount).toBe(2);
    const texts = result.received.map((r) => Buffer.from(r.payload, 'base64').toString());
    expect(texts).toEqual(['re:alpha', 're:beta']);
    echo.server.close();
  }, 15_000);

  it('reports a connection error rather than throwing', async () => {
    const result = await replayWebSocket({
      url: 'ws://127.0.0.1:1/nope',
      frames: [],
      timeoutMs: 2000,
    });
    expect(result.error).toBeTruthy();
    expect(result.sentCount).toBe(0);
  }, 15_000);

  it('rejects a non-ws url', async () => {
    await expect(
      replayWebSocket({ url: 'https://example.com/x', frames: [] }),
    ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/ws-replay.test.ts`
Expected: FAIL — `Failed to resolve import "./ws-replay.js"`

- [ ] **Step 3: Add the request/response types**

Append to `src/shared/types.ts`:

```ts
export interface WsReplayFrame {
  opcode: 'text' | 'binary';
  /** base64-encoded */
  payload: string;
  /** milliseconds to wait after the previous frame */
  delayMs: number;
}

export interface WsReplayRequest {
  url: string;
  frames: WsReplayFrame[];
  timeoutMs?: number;
}

export interface WsReplayResponse {
  sentCount: number;
  received: { opcode: 'text' | 'binary'; payload: string; offsetMs: number }[];
  durationMs: number;
  closeCode: number | null;
  error?: string;
}
```

- [ ] **Step 4: Implement replay**

Create `src/server/ws-replay.ts`:

```ts
import type {
  RequestRecord,
  WebSocketMessage,
  WsReplayFrame,
  WsReplayRequest,
  WsReplayResponse,
} from '../shared/types.js';

const DEFAULT_TIMEOUT = 30_000;
/** Idle window after the last frame before we assume the server is done replying. */
const QUIET_PERIOD = 500;

/**
 * Build a replay request from a recorded connection: client-sent data frames
 * only, with delays derived from the original inter-frame gaps.
 */
export function recordToWsReplayRequest(
  record: RequestRecord,
  messages: WebSocketMessage[],
): WsReplayRequest {
  const url = record.url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

  const sent = messages
    .filter((m) => m.direction === 'sent' && (m.opcode === 'text' || m.opcode === 'binary'))
    .sort((a, b) => a.timestamp - b.timestamp);

  const frames: WsReplayFrame[] = sent.map((message, index) => ({
    opcode: message.opcode as 'text' | 'binary',
    payload: message.payload ? Buffer.from(message.payload).toString('base64') : '',
    delayMs: index === 0 ? 0 : message.timestamp - sent[index - 1].timestamp,
  }));

  return { url, frames };
}

export function replayWebSocket(request: WsReplayRequest): Promise<WsReplayResponse> {
  if (!request.url.startsWith('ws://') && !request.url.startsWith('wss://')) {
    return Promise.reject(new Error(`URL must start with ws:// or wss://: ${request.url}`));
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT;
  const startedAt = Date.now();

  return new Promise<WsReplayResponse>((resolve) => {
    const received: WsReplayResponse['received'] = [];
    let sentCount = 0;
    let closeCode: number | null = null;
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const socket = new WebSocket(request.url);
    socket.binaryType = 'arraybuffer';

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      try { socket.close(); } catch { /* already closed */ }
      resolve({
        sentCount,
        received,
        durationMs: Date.now() - startedAt,
        closeCode,
        ...(error ? { error } : {}),
      });
    };

    const hardTimer = setTimeout(() => finish('Replay timed out'), timeoutMs);

    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), QUIET_PERIOD);
    };

    socket.onopen = async () => {
      for (const frame of request.frames) {
        if (settled) return;
        if (frame.delayMs > 0) {
          await new Promise((r) => setTimeout(r, frame.delayMs));
        }
        if (settled) return;
        const bytes = Buffer.from(frame.payload, 'base64');
        socket.send(frame.opcode === 'text' ? bytes.toString('utf8') : bytes);
        sentCount++;
      }
      armQuietTimer();
    };

    socket.onmessage = (event: MessageEvent) => {
      const isText = typeof event.data === 'string';
      const payload = isText
        ? Buffer.from(event.data as string, 'utf8')
        : Buffer.from(event.data as ArrayBuffer);
      received.push({
        opcode: isText ? 'text' : 'binary',
        payload: payload.toString('base64'),
        offsetMs: Date.now() - startedAt,
      });
      armQuietTimer();
    };

    socket.onclose = (event: CloseEvent) => {
      closeCode = event.code;
      finish();
    };

    socket.onerror = () => finish(`Failed to connect to ${request.url}`);
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/server/ws-replay.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Add the API endpoint**

In `src/server/api.ts`:

```ts
import { replayWebSocket, recordToWsReplayRequest } from './ws-replay.js';
import type { WsReplayRequest } from '../shared/types.js';
```
```ts
  router.post('/websocket/replay', async (req: Request, res: Response) => {
    const body = req.body as Partial<WsReplayRequest> & { requestId?: string };

    let replayRequest: WsReplayRequest;
    if (body.requestId) {
      const record = db.getById(body.requestId);
      if (!record) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (record.kind !== 'websocket') {
        res.status(400).json({ error: 'Request is not a WebSocket connection' });
        return;
      }
      const messages = db.getWebSocketMessages(body.requestId, 10_000, 0);
      replayRequest = recordToWsReplayRequest(record, messages.data);
    } else if (body.url && Array.isArray(body.frames)) {
      replayRequest = { url: body.url, frames: body.frames, timeoutMs: body.timeoutMs };
    } else {
      res.status(400).json({ error: 'Provide either requestId, or url and frames' });
      return;
    }

    try {
      res.json(await replayWebSocket(replayRequest));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/ws-replay.ts src/server/ws-replay.test.ts src/server/api.ts src/shared/types.ts
git commit -m "feat: add WebSocket connection replay"
```

---

### Task 13: Messages tab in the web UI

**Files:**
- Modify: `src/ui/components/RequestDetail.tsx`, `src/ui/client.ts`

**Interfaces:**
- Consumes: `GET /api/requests/:id/messages`, `POST /api/websocket/replay`, SSE `ws-message`
- Produces: `getMessages(requestId)`, `replayWebSocketConnection(requestId)` on the UI client

- [ ] **Step 1: Add client methods**

In `src/ui/client.ts`:

```ts
export interface UiWsMessage {
  id: string;
  request_id: string;
  timestamp: number;
  direction: 'sent' | 'received';
  opcode: 'text' | 'binary' | 'ping' | 'pong' | 'close';
  payload: string | null;   // base64
  size: number;
  truncated: number;
}

export async function getMessages(requestId: string): Promise<{ data: UiWsMessage[]; total: number }> {
  const res = await fetch(`/api/requests/${requestId}/messages`);
  if (!res.ok) throw new Error('Failed to load messages');
  return res.json();
}

export async function replayWebSocketConnection(requestId: string): Promise<unknown> {
  const res = await fetch('/api/websocket/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Replay failed');
  return res.json();
}
```

- [ ] **Step 2: Add the tab**

In `src/ui/components/RequestDetail.tsx`, add a `Messages` tab to the existing tab
strip, rendered only when `record.kind === 'websocket'`. Fetch on tab activation,
then append live frames from the existing SSE connection filtered by `request_id`.

Render each frame as a row: direction arrow, opcode, size, timestamp, and payload.
Decode base64 to UTF-8 for `text` frames and pretty-print when the payload parses as
JSON; show `<N bytes>` for `binary`. Add a "Replay connection" button that calls
`replayWebSocketConnection` and shows the returned frame count and replies.

Follow the existing Tailwind class conventions and the tab-state pattern already in
this file. Use `→` for `sent` and `←` for `received`, matching the CLI output.

- [ ] **Step 3: Verify in the browser**

```bash
npm run build && node dist/cli/index.js start
```
Drive WebSocket traffic through the proxy, open the connection in the UI, confirm the
Messages tab lists frames live, and that "Replay connection" returns replies.

- [ ] **Step 4: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, and a clean TypeScript build with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/client.ts src/ui/components/RequestDetail.tsx
git commit -m "feat: add WebSocket messages tab to web UI"
```

---

## Task 14: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/websocket.md`, `docs/throttling.md`

- [ ] **Step 1: Document WebSocket capture**

Create `docs/websocket.md` covering: what is captured (handshake as a request row
with `kind=websocket`, frames in `websocket_messages`), the deliberate
`Sec-WebSocket-Extensions` strip and its consequence (no `permessage-deflate` on
intercepted connections), `laurel-proxy messages <id> [--follow]`, the
`GET /api/requests/:id/messages` and `POST /api/websocket/replay` endpoints, and the
`ws-message` SSE event.

- [ ] **Step 2: Document throttling**

Create `docs/throttling.md` with the preset table (values copied from
`THROTTLE_PRESETS`), the CLI examples, the REST endpoints, the shared-pipe semantics
(all connections contend for one link), and the two documented simplifications:
latency is injected once per HTTP exchange, and WebSocket connections are
bandwidth-paced but not latency-delayed.

- [ ] **Step 3: Update CLAUDE.md**

Add a short "Features" section listing WebSocket capture and throttling with pointers
to the two new docs, so future sessions discover them without reading source.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/websocket.md docs/throttling.md
git commit -m "docs: document WebSocket capture and bandwidth throttling"
```

---

## Done criteria

- [ ] `npm test` passes, including every pre-existing test
- [ ] `npm run build` completes with no TypeScript errors
- [ ] `laurel-proxy throttle 3g` then `laurel-proxy throttle --status` round-trips
- [ ] A real WebSocket connection through the proxy appears with `kind=websocket`, its
      frames are listed by `laurel-proxy messages <id>`, and the relayed payloads are
      byte-identical to what the application sent
- [ ] The web UI shows a throttle control and a Messages tab
- [ ] `docs/websocket.md` and `docs/throttling.md` exist

## Follow-up work (not this plan)

- **Breakpoints / live rewriting.** Separate plan. The `ExchangeDeps` hook points
  added in Task 1 and the `handleExchange` await points are where it inserts.
- **Website comparison page update.** Handled after this ships by generating an LLM
  prompt describing the shipped capabilities. Do not edit that repo here.
- **HTTP/2.** Deferred; own project.
- **Upstream TLS verification.** `rejectUnauthorized: false` is carried forward
  verbatim from the existing `handleMitmRequest` into `handleExchange` (T1) and
  `handleWebSocketUpgrade` (T9), because Task 1 is a deliberate no-behaviour-change
  refactor. It is worth revisiting separately: it means Laurel silently accepts
  invalid upstream certificates, hiding real TLS misconfigurations from the developer.
  Charles verifies upstream certs and surfaces failures. Changing it is a behaviour
  change with its own test matrix, so it does not belong in this plan.
