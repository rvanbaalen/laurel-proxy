# Charles Proxy Parity: WebSocket Capture, Throttling, Breakpoints

**Date:** 2026-08-01
**Status:** Approved design

## Motivation

The website's [Charles Proxy comparison page](https://github.com/rvanbaalen/laurelproxy-website/blob/main/src/pages/compare/charles-proxy-alternative.astro)
lists five gaps where Charles wins. This project closes three of them:

| Gap | In scope |
| --- | --- |
| WebSocket capture | Yes |
| Bandwidth throttling | Yes |
| Request breakpoints / live rewriting | Yes (bonus tier) |
| Full HTTP/2 support | No — deferred, separate project |
| Windows support | No — not a priority |

Explicitly out of scope: rewrite rules, Map Local, Map Remote, HTTPS interception
changes (already works), and any desktop UI. Laurel stays CLI + web UI + REST API.

The website repo is **out of scope for this project**. Its comparison page and FAQ
currently assert these features are missing — three table rows, three bullets in
"Where Charles Proxy is still better", two bullets in "Stick with Charles Proxy
if...", and one FAQ answer. Once the implementation lands, that update is handled
separately by generating an LLM prompt describing the shipped capabilities. Do not
edit the website repo as part of this work.

## Architecture

### The problem with the current proxy

`src/server/proxy.ts` has two near-duplicate handlers:

- `handleRequest` — plain HTTP, ~70 lines
- `handleMitmRequest` — HTTPS after TLS termination, ~70 lines

They differ in exactly three values: where hostname/port come from, how the
recorded URL is built, and the `protocol` field. Everything else is copied.

Both fully buffer the upstream response, then write it to the client in a single
`clientRes.end(responseBody)`. That blocks both new features:

- **Throttling** needs incremental writes to pace. There is nothing to pace when
  the whole body is written at once.
- **Breakpoints** need a suspension point between "response headers received" and
  "response sent to client". There is no seam.

### The exchange pipeline

Introduce `src/server/exchange.ts` holding one handler for both transports:

```
buffer request body
  → [hook: breakpoint on request]         may mutate headers/body/method/url, or abort
  → apply upload throttle while writing to upstream
  → open upstream connection (http or https per transport)
  → receive response headers
  → [hook: breakpoint on response]        may mutate status/headers/body, or abort
  → inject configured latency (once, before first byte)
  → stream chunks to client through the download throttle gate,
     accumulating a maxBodySize-capped copy for the record
  → write record to the batch queue + emit SSE event
```

The three differing values become parameters. `proxy.ts` retains only listener
and socket lifecycle plus dispatch of the `request`, `connect`, and `upgrade`
events.

Two behaviour changes fall out of this refactor, both improvements:

1. Responses stream rather than fully buffering, lowering peak memory on large
   bodies. The recorded copy is still capped at `maxBodySize`.
2. `content-length` is rewritten only when a hook actually modified the body,
   instead of unconditionally on every response.

Hooks are async and default to identity. With throttling off and no breakpoint
rules, the pipeline is behaviourally equivalent to today's code.

### Module layout

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `src/server/exchange.ts` | The pipeline above; one HTTP exchange end to end | db, events, throttle, breakpoints |
| `src/server/ws-frames.ts` | Pure RFC 6455 frame decoder | nothing |
| `src/server/websocket.ts` | Upgrade handshake forwarding + byte relay + frame observation | db, events, ws-frames, throttle |
| `src/server/ws-replay.ts` | Re-open a recorded connection, resend its client frames | ws-frames |
| `src/server/throttle.ts` | Token buckets, presets, latency | nothing |
| `src/server/breakpoints.ts` | Rule matching, pending intercept registry, resume/abort/timeout | events |
| `src/server/proxy.ts` | Listener + socket lifecycle + event dispatch (shrinks) | exchange, websocket |

Each is independently testable: `ws-frames` and `throttle` have no I/O at all,
`breakpoints` needs only an event manager.

## Feature 1: WebSocket capture and replay

### Detection and relay

`proxy.ts` gains an `upgrade` listener. The MITM virtual server created in
`handleConnect` gets the same listener, so `wss://` behaves identically to `ws://`.

After forwarding the upgrade request upstream and relaying the `101` response,
bytes are piped **through untouched** in both directions. Frames are decoded by a
*passive observer* on each direction and never re-encoded. This is a deliberate
safety property: a decoder bug can corrupt a recording but can never corrupt the
traffic the application sees.

`Sec-WebSocket-Extensions` is stripped from the upgrade request so the server
cannot negotiate `permessage-deflate` and frames stay plaintext. This mirrors the
existing `stripEncoding` decision for HTTP bodies. The cost is that Laurel
suppresses WebSocket compression on intercepted connections; the benefit is that
every captured frame is readable without a decompression path.

### Frame decoder

`src/server/ws-frames.ts` is a stateful but pure decoder — bytes in, decoded
messages out, no sockets. It must handle:

- Masked (client→server) and unmasked (server→client) frames
- All three payload length encodings: 7-bit, 16-bit, 64-bit
- Continuation frames reassembled into one logical message
- Control frames: ping, pong, close
- Frames split arbitrarily across TCP chunk boundaries, and multiple frames
  arriving in one chunk

### Storage

The upgrade handshake is recorded as an ordinary `requests` row with `status` 101,
so WebSocket connections appear in existing lists, filters, and search with no
changes to the query layer. Frames go to a new table:

```sql
CREATE TABLE IF NOT EXISTS websocket_messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  direction TEXT NOT NULL,      -- 'sent' = client→server, 'received' = server→client
  opcode TEXT NOT NULL,         -- 'text' | 'binary' | 'ping' | 'pong' | 'close'
  payload BLOB,
  size INTEGER NOT NULL,
  truncated INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ws_request_id ON websocket_messages(request_id);
CREATE INDEX IF NOT EXISTS idx_ws_timestamp ON websocket_messages(timestamp);
```

`requests` also gains `kind TEXT DEFAULT 'http'` (values `http` | `websocket`) so
a connection that carried zero frames is still identifiable as a WebSocket. This
requires a guarded migration: read `PRAGMA table_info(requests)` and issue
`ALTER TABLE requests ADD COLUMN kind TEXT DEFAULT 'http'` only when the column is
absent. Existing databases must open cleanly and existing rows default to `http`.

Frames enqueue through the existing 100 ms batch write queue. Per-frame payloads
cap at `maxBodySize` and set `truncated` when clipped, matching HTTP body handling.

### Replay

`src/server/ws-replay.ts` re-opens the recorded URL using Node's built-in global
`WebSocket` (stable in Node 22; the project runs Node 22.21.1) and re-sends that
connection's `sent` frames in recorded order, preserving original inter-frame
delays, while collecting frames that arrive in response. No new dependency.

This is the WebSocket analogue of the existing HTTP Repeater and mirrors
`src/server/replay.ts` in shape: a single async function, a request type in, a
result type out, a hard timeout.

### Surfaces

- `GET /api/requests/:id/messages` — paginated frames for a connection
- `POST /api/websocket/replay` — replay a recorded connection
- SSE `ws-message` event for live frames
- Messages tab in `src/ui/components/RequestDetail.tsx`
- `laurel-proxy messages <id> [--follow]`, honouring the existing `--format` flag

## Feature 2: Bandwidth throttling

### Model

Two global token buckets, one up and one down, **shared across all connections**
as Charles does. This matters for realism: N parallel requests should contend for
one pipe rather than each independently receiving the full configured rate.

`await bucket.consume(n)` computes the deficit against the refill rate and sleeps
exactly that long, then returns. No polling interval. The exchange pipeline awaits
it per chunk while streaming; the WebSocket relay awaits it per frame batch, so
both paths are paced by the same buckets.

Latency is injected once per exchange, immediately before the first response byte
reaches the client. Charles models a full round trip; a single injection point is
simpler to reason about and observably equivalent for one request/response pair.
This is a documented simplification, not an oversight.

Latency applies to HTTP exchanges only. WebSocket connections are paced by the
bandwidth buckets but receive no per-frame latency injection — adding delay to
every frame would badly distort the timing of a long-lived connection, which is
usually the thing being debugged.

### Presets

Named presets plus fully custom values. Downstream/upstream in kbps, latency in ms:

| Preset | Down | Up | Latency |
| --- | --- | --- | --- |
| `56k` | 56 | 33 | 120 |
| `edge` | 240 | 200 | 400 |
| `3g` | 780 | 330 | 100 |
| `4g` | 4000 | 3000 | 20 |
| `dsl` | 2000 | 256 | 40 |
| `wifi` | 30000 | 15000 | 5 |

Off by default. Persisted under a `throttle` key in `~/.laurel-proxy/config.json`
so it survives restarts, and live-updatable at runtime without restarting the
proxy — changing the rate reconfigures the existing buckets in place.

### Surfaces

- `GET /api/throttle`, `PUT /api/throttle`
- `laurel-proxy throttle <preset>`, `laurel-proxy throttle off`,
  `laurel-proxy throttle --down 400kbps --up 200kbps --latency 100ms`,
  `laurel-proxy throttle status`
- A control in `src/ui/components/Controls.tsx`

Rate strings reuse the existing `parseSize`/`parseDuration` helpers in
`src/server/config.ts` where the formats overlap.

## Feature 3: Request breakpoints (bonus tier)

### Rules and interception

A rule is:

```ts
interface BreakpointRule {
  id: string;
  enabled: boolean;
  method?: string;              // exact, case-insensitive
  host?: string;                // glob
  path?: string;                // glob
  phase: 'request' | 'response' | 'both';
}
```

When a rule matches at a hook point, the pipeline parks the exchange on a promise,
registers a pending intercept, and emits an SSE `breakpoint` event carrying the
editable payload (method, url, headers, body, and status for response-phase).

Resume with `POST /api/intercepts/:id/resume` and edited fields, which resolves the
promise with the mutated data; or `POST /api/intercepts/:id/abort`, which fails the
exchange with a 502.

Rules persist in `~/.laurel-proxy/config.json` under a `breakpoints` key.

### Timeout is the critical safety property

An unattended breakpoint would otherwise hang the client indefinitely. Two
guarantees:

1. **Timeout.** Default 60 s, configurable. On expiry the exchange
   **auto-continues unmodified** and the intercept is marked timed-out. Charles
   aborts instead; auto-continuing is the better default here because a stale
   breakpoint should be invisible rather than break the page.
2. **Shutdown release.** Stopping the proxy resolves every pending intercept
   unmodified, so `stop()` never blocks on a parked exchange.

### Surfaces

- `/api/breakpoints` — CRUD
- `GET /api/intercepts` — list pending
- `POST /api/intercepts/:id/resume`, `POST /api/intercepts/:id/abort`
- SSE `breakpoint` event
- Web UI panel with an editable headers/body form and Continue / Abort buttons —
  the natural home for a multi-field editor
- `laurel-proxy intercepts` to list, `laurel-proxy resume <id> [--file edited.json] [--abort]`
  as the terminal fallback

## Error handling

- **Upstream WebSocket refuses the upgrade.** Relay the non-101 response to the
  client verbatim and record it as an ordinary request row.
- **Decoder encounters a malformed frame.** Stop decoding that direction, mark the
  connection's recording as degraded, and keep relaying bytes. Traffic must never
  be affected by a recording failure.
- **Client or upstream disconnects mid-connection.** Flush buffered frames, record
  a close, tear down the paired socket.
- **Breakpoint resume with invalid payload.** Reject with 400 and leave the
  intercept pending, so a bad edit is retryable rather than fatal.
- **Throttle reconfigured mid-stream.** In-flight `consume` calls settle against
  the old rate; subsequent chunks use the new one. No attempt to retroactively
  repace.

## Testing

The existing suite covers precisely the code path section 1 refactors. It is the
safety net for that refactor and must stay green at every step.

**Unit:**
- `ws-frames.test.ts` — masking, all three length forms, continuation reassembly,
  control frames, frames split across chunks, multiple frames per chunk,
  malformed input
- `throttle.test.ts` — token bucket math under fake timers, preset resolution,
  bucket reconfiguration, disabled passthrough
- `breakpoints.test.ts` — glob rule matching, phase selection, resume mutation,
  abort, timeout auto-continue, shutdown release
- `db.test.ts` additions — WebSocket message insert/query, and the `kind` column
  migration applied to a database file created by the pre-migration schema

**Integration:**
- `websocket.integration.test.ts` — a real WebSocket server behind the real proxy;
  assert frames are recorded **and** that relayed payloads are byte-identical to
  what was sent, over both `ws://` and `wss://`
- `throttle.integration.test.ts` — a known-size body at a known rate takes at
  least the expected wall-clock time
- `breakpoints.integration.test.ts` — a parked request resumes with mutations
  applied, aborts produce a 502, and a rule with no resume times out and continues

## Deferred

- **HTTP/2.** Requires ALPN `h2`, a `node:http2` server on the MITM side, an
  upstream h2 client, and stream multiplexing through the pipeline. Highest
  regression risk of the five gaps; its own project.
- **Windows support.** Not a priority.
- **Rewrite rules / Map Local / Map Remote.** The exchange pipeline's hooks are the
  natural insertion point, so this becomes small once the pipeline exists.
- **WebSocket frame injection into a live connection.** Would need a registry of
  live connections and a write path into the relay; replay covers the primary
  debugging need.
