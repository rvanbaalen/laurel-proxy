# HTTP/2 Support Implementation Plan

**Goal:** Intercept HTTP/2 as HTTP/2 — negotiate it with clients via ALPN, speak it to origins, and record it — with no flag and no user decision.

**Architecture:** ALPN already exists to solve this, so we use it properly. The MITM TLS socket offers `['h2', 'http/1.1']` and the client picks; separately, we negotiate with the origin and use whatever it supports. The two hops are independent: an h2 client talking to an h1.1-only origin works, and so does the reverse. Node's HTTP/2 compatibility API (`Http2ServerRequest`/`Http2ServerResponse`) deliberately mirrors the HTTP/1 shapes, which is what makes reusing the existing exchange pipeline viable.

**Tech Stack:** `node:http2` (built in — no new dependency), Node 22.21.1, TypeScript `nodenext`, Vitest 4.

## Global Constraints

- **No new runtime dependencies.** `node:http2` is built in.
- ESM: server/test relative imports carry `.js`; `src/ui/**` uses `.ts`.
- **The recording invariant holds:** a recording failure may lose a recording but must never affect the bytes an application sees, nor terminate the process. `src/shared/never-fatal.ts` provides `neverFatal`/`recordSafely`/`observeSafely`, which take a **thunk** so record construction happens inside the guard. Any new record site must use them.
- **Traffic fidelity:** never alter bytes to make recording easier.
- The existing HTTP/1.1 path is load-bearing and covered by 357 tests. It must stay green at every step; that suite is the safety net for this whole project.
- Never run anything that changes the host's network configuration: no `laurel-proxy start`, no `proxy-on`, no interactive TUI.
- `npm test`, `npm run typecheck` (three projects), `npm run build` clean before every commit.

## The defect class to watch for

Roughly a third of everything found in the previous project was **partial or unknown state reported as success** — silent truncation, unknown state rendered as a definite value, partial work reported complete. HTTP/2 adds fresh opportunities: a stream reset mid-response, a `GOAWAY` arriving mid-exchange, a partially-received body. None of those may be recorded as a clean exchange.

## Current state

- `src/server/proxy.ts:192` — `ALPNProtocols: ['http/1.1']`, the single line that forbids h2 today.
- `src/server/proxy.ts:199` — `http.createServer(...)` then `virtualServer.emit('connection', tlsSocket)`, the virtual-server trick that will need an h2 sibling.
- `src/server/exchange.ts` — `handleExchange(clientReq: http.IncomingMessage, clientRes: http.ServerResponse, ...)`, and upstream via `transport.request(options, cb)` where transport is `node:http` or `node:https`.
- `node:http2` appears nowhere.

---

## Task 1: Upstream transport abstraction with h2 support

The harder half. `node:https` has no h2 path, so this is a second transport, not a flag.

**Files:** create `src/server/upstream.ts`; test `src/server/upstream.test.ts`, `tests/integration/http2-upstream.integration.test.ts`

**Deliverable:** one function the pipeline can call without knowing which protocol was used — give it a target plus request headers and a body, get back status, headers, a readable body stream, and which protocol was actually negotiated.

Requirements:

- **ALPN discovery per origin.** Offer `h2` and `http/1.1` to the origin and use what it picks. Cache the result per `host:port` so every request doesn't re-probe — but bound the cache and make sure a stale negative doesn't pin an origin to h1.1 forever.
- **Session pooling.** `http2.connect()` opens a session, not a request. Reuse it across requests to the same origin, and handle `GOAWAY`, session errors, and idle timeouts by discarding and reconnecting. A dead pooled session must not fail the request that discovered it — retry once on a fresh session.
- **Header translation.** h2 requires lowercase header names, uses pseudo-headers (`:method`, `:path`, `:authority`, `:scheme`), and **forbids** `Connection`, `Transfer-Encoding`, `Keep-Alive`, `Proxy-Connection`, and `Upgrade`. Strip them and map `Host` → `:authority`. Getting this wrong produces a protocol error, not a bad response.
- **Response translation back.** Strip `:status` into a numeric status; present remaining headers in the same shape the HTTP/1.1 path produces, so the recording layer sees one format.
- Keep `rejectUnauthorized: false` for upstream TLS, matching the existing behaviour (deliberate for an intercepting proxy; changing it is out of scope).

Risks to reason about and report on:

- **Stream errors vs session errors.** A single stream can fail while the session is healthy. Distinguish them; do not tear down a session for one bad stream.
- **`GOAWAY` mid-exchange** — the origin is refusing new streams but may finish in-flight ones. What does the caller see?
- **Trailers.** h2 can send trailing headers. Decide whether to record them and say what you chose.
- **Flow control.** h2 has per-stream windows; a slow consumer must not deadlock. Confirm backpressure works with the existing `waitForDrain` helper in `src/server/stream-utils.ts`.

Test against a real `http2` server on an ephemeral port. Falsify every test: break the property, confirm RED, restore, confirm GREEN — and verify the GREEN half too, not just RED. Four times in the previous project a green test turned out to prove nothing.

---

## Task 2: Widen the exchange pipeline to both request/response shapes

**Files:** modify `src/server/exchange.ts`, `src/server/proxy.ts`; tests alongside.

`Http2ServerRequest`/`Http2ServerResponse` are **not** subclasses of `http.IncomingMessage`/`http.ServerResponse` — they are separate classes with deliberately similar APIs. So the pipeline's parameter types must become structural: define the minimal surface `handleExchange` actually uses (`method`, `url`, `headers`, async iteration, `writeHead`, `write`, `end`, `destroyed`, `writableEnded`) and type against that.

**No behaviour change in this task.** It is a typing and seam change only; the 357 existing tests are the oracle. Also swap the upstream call to Task 1's abstraction, still exercising only the h1.1 path.

Watch for: `sendableStatus` must keep coercing the wire only, never the recorded status. `writeHead` on an h2 response rejects HTTP/1-only headers, so the header-stripping that currently happens for the h1.1 path may need to move.

---

## Task 3: Client-side h2 — ALPN and the virtual server

**Files:** modify `src/server/proxy.ts`; test `tests/integration/http2.integration.test.ts`

- Offer `ALPNProtocols: ['h2', 'http/1.1']` on the MITM TLS socket.
- Branch on `tlsSocket.alpnProtocol` after the handshake (server-side TLS sockets emit `secure`, not `secureConnect`). On `h2`, hand the socket to an `http2.createServer()` — the plain-socket variant, since TLS is already terminated — via the same `emit('connection', ...)` trick the HTTP/1.1 path uses. Otherwise keep the current path exactly.
- Route h2 requests through the same pipeline via the compatibility API.

Requirements and risks:

- **`alpnProtocol` can be `false` or `undefined`** when the client offers no ALPN at all. That must land on the HTTP/1.1 path, not crash and not be treated as h2.
- **Per-CONNECT server creation.** The current code creates a fresh `http.createServer()` per CONNECT, which is wasteful but works. Do not make it worse: an h2 server per CONNECT is also acceptable for now, but note the cost.
- **WebSockets over h2 are out of scope.** That is RFC 8441 Extended CONNECT, a different mechanism from the `Upgrade` path already built. An h2 client attempting it must fail cleanly, not hang or half-work. Confirm the existing `Upgrade`-based WebSocket capture still works when the client negotiates h1.1 — which it will, since that path is untouched.
- **Cleartext h2 (`h2c`) is out of scope** — prior-knowledge and `Upgrade`-based h2c are rare and not what browsers do.

---

## Task 4: Record and surface the negotiated protocol

**Files:** modify `src/shared/types.ts`, `src/storage/db.ts`, `src/server/exchange.ts`, `src/server/api.ts`, `src/cli/format.ts`, `src/ui/**`; docs.

Today `RequestRecord.protocol` is `'http' | 'https'` — the URL scheme, not the wire protocol. An intercepted h2 exchange and an intercepted h1.1 exchange are indistinguishable in the recording, which defeats the point of supporting h2 at all.

- Add a field for the negotiated wire protocol (`http/1.1` | `h2`) for **both** hops, since they are independent — a client on h2 talking to an h1.1 origin is exactly the kind of thing a developer needs to see.
- Guarded, idempotent migration against real users' existing databases, following the `kind` column precedent in `src/storage/db.ts`: check `PRAGMA table_info` before `ALTER TABLE`, existing rows get a sensible default, and test against a database built with the pre-migration schema.
- Surface it: CLI (`requests` table and `--format agent` via `toAgentRecord`; a filter flag), REST (`GET /api/requests` response and a query filter), and the web UI (traffic list and request detail). The previous project shipped a `kind` column that never reached the agent surface and needed a follow-up — don't repeat that: agent discoverability is part of this task, not a later one.
- Update `docs/architecture.astro`-equivalent docs in this repo plus `skills/laurel-proxy/SKILL.md`, and flag that the website's three comparison pages plus its docs still say HTTP/2 is unsupported.

---

## Done criteria

- A real HTTP/2 client through the proxy is recorded as h2, end to end, with the body intact.
- An h2 client against an h1.1-only origin works, and both hops are visible in the recording.
- An h1.1 client is completely unaffected — the existing 357 tests plus the WebSocket suite stay green.
- A client offering no ALPN lands on HTTP/1.1.
- `npm test`, all three typecheck projects, and `npm run build` clean.

## Out of scope

WebSockets over HTTP/2 (RFC 8441), cleartext h2c, HTTP/3 and QUIC, server push (deprecated and unimplemented in browsers), and request breakpoints.
