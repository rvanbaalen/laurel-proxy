import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';

/**
 * The upstream half of the proxy's two hops.
 *
 * `node:https` has no HTTP/2 path at all, so speaking h2 to an origin is a
 * second transport rather than an option on the first one. This module is the
 * seam that hides that: {@link UpstreamTransport.request} takes a target, headers
 * and a body, and returns a status, headers, a body stream and the protocol that
 * was actually negotiated. The exchange pipeline never branches on protocol.
 *
 * ## What "complete" means here, and why it is a separate signal
 *
 * The failure mode this project fears most is partial state reported as success,
 * and HTTP/2 supplies several new ways to produce it. So a response carries two
 * independent completion signals, and callers get both for free:
 *
 * 1. **The body stream errors** on any abnormal termination, so the existing
 *    `for await (…)` in the pipeline throws exactly as it does for HTTP/1.1.
 * 2. **{@link UpstreamResponse.bodyStatus} reports `truncated`** with a reason,
 *    for callers that want to say *why* rather than merely bail.
 *
 * Both are needed. (1) alone puts the whole burden on a `catch` that a future
 * edit could widen; (2) alone would be silently ignorable.
 *
 * ## How silent truncation actually shows up, measured
 *
 * On Node 22.21.1, an h2 response that stops early frequently does **not** error.
 * These were established against a real `node:http2` server, not from the docs:
 *
 * | how the response stopped            | client sees                        |
 * |-------------------------------------|------------------------------------|
 * | origin resets with an error code    | `'error'`, `rstCode` = that code   |
 * | session or socket dies mid-body     | **no error**, `'end'`, `rstCode` 8 |
 * | short of a declared `content-length`| `'error'` (PROTOCOL_ERROR)         |
 * | `RST_STREAM(NO_ERROR)`, no length   | **nothing at all** — see below     |
 *
 * The second row is the trap: `internal/http2/core.js`'s `closeStream` sets
 * `rstCode` and then pushes `null`, so the readable **ends cleanly** and a
 * `for await` simply finishes. That is why {@link countingBody} checks `rstCode`
 * at `end` rather than trusting `end`, and why it drives the source-to-consumer
 * coupling by hand instead of using `pipeline` (which reports that same case as
 * success).
 *
 * The last row is a genuine blind spot. `_destroy` deliberately does not
 * synthesise an error for `NO_ERROR`/`CANCEL`, and with no declared length there
 * is nothing left to check: every observable property is identical to a clean
 * response. Detecting it needs frame-level parsing, i.e. interposing a Duplex
 * between the TLS socket and the session — real cost and real risk for a rare
 * shape, so it is deliberately not done here and left as a known gap.
 *
 * (Note that Node's *server* `stream.close(code)` is not this case: it ends the
 * writable side first, so a peer receives a complete message and then a reset.
 * A test that wants a real mid-response reset must use `stream.destroy(err)`.)
 *
 * ## Response trailers are dropped, deliberately
 *
 * {@link UpstreamResponse} used to carry a `trailers()` accessor, implemented for
 * both protocols and consumed by **nothing**: trailers reached neither the client
 * nor the recording. Rather than leave dead API surface implying a fidelity this
 * proxy does not have, they are dropped explicitly and the gap is stated in
 * `docs/http2.md` and `skills/laurel-proxy/SKILL.md`.
 *
 * Recording them is the bigger of the two changes, not the smaller: a trailer
 * block is a second header set, so it needs a `RequestRecord` field, a guarded
 * migration and a route to the CLI/REST/UI surfaces — otherwise it repeats the
 * `kind` column that shipped without ever reaching the agent surface. Relaying
 * them instead would alter the bytes an application sees, since an HTTP/1.1 client
 * only consents to trailers via `TE: trailers`. HTTP/1.1 has always dropped them
 * here, so nothing regresses either way.
 *
 * What is *not* dropped is the guarantee that a trailer cannot corrupt a
 * recording: trailers were never merged into `headers`, so a trailer named like a
 * header cannot overwrite what the origin actually sent in its header block. A
 * test against a real trailer-sending origin pins that.
 */

/** The wire protocol negotiated with the origin. Not the URL scheme. */
export type NegotiatedProtocol = 'http/1.1' | 'h2';

export interface UpstreamTarget {
  hostname: string;
  port: number;
  /** URL scheme of the target, which decides whether ALPN happens at all. */
  protocol: 'http' | 'https';
  path: string;
}

export interface UpstreamRequestInit {
  target: UpstreamTarget;
  method: string;
  /** Already hop-by-hop-filtered by the caller; h2-forbidden names are stripped here. */
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
}

/**
 * Whether the response body arrived in full.
 *
 * `pending` until the body stream ends or fails — asking earlier gets an honest
 * "don't know yet" rather than a default that reads as success.
 */
export type BodyStatus =
  | { state: 'pending' }
  | { state: 'complete' }
  | { state: 'truncated'; reason: string };

export interface UpstreamResponse {
  /** What the origin actually spoke, for the caller to record. */
  protocol: NegotiatedProtocol;
  /**
   * The status exactly as the origin stated it — including values no HTTP/1.1
   * server writer would accept. Callers put `sendableStatus()` on the wire and
   * this in the record; see `exchange.ts`.
   */
  status: number | undefined;
  /** Lowercased header names, `set-cookie` as an array: one shape for both protocols. */
  headers: http.IncomingHttpHeaders;
  /** Async-iterable `Buffer` stream that errors on any abnormal termination. */
  body: Readable;
  bodyStatus(): BodyStatus;
}

export interface UpstreamOptions {
  /** How long a positive (`h2`) ALPN result is trusted. */
  h2TtlMs?: number;
  /**
   * How long a negative (`http/1.1`) ALPN result is trusted. Deliberately much
   * shorter than {@link h2TtlMs}: a cached negative is the entry that can pin an
   * origin to HTTP/1.1 after it has gained h2 support, so it has to age out fast.
   */
  h1TtlMs?: number;
  /** Bound on the ALPN cache. Oldest entry is evicted first. */
  maxAlpnEntries?: number;
  /** Bound on pooled h2 sessions. Least-recently-used idle session is closed. */
  maxSessions?: number;
  /** Idle time after which a pooled session is unpooled and gracefully closed. */
  sessionIdleMs?: number;
  /** Cap on the ALPN probe handshake. */
  probeTimeoutMs?: number;
  /** Cap on an h2 session handshake. */
  connectTimeoutMs?: number;
  /** Seam for tests: replaces `http2.connect`. */
  connect?: (authority: string, options: http2.SecureClientSessionOptions) => http2.ClientHttp2Session;
}

/** Headers HTTP/2 forbids outright. Sending any of them throws synchronously. */
const H2_FORBIDDEN = new Set([
  'connection',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'upgrade',
  'http2-settings',
]);

/**
 * Error codes that mean "this request was definitively not processed".
 *
 * Retrying is only safe for these. `GOAWAY` names the last stream the origin
 * handled and Node raises `ERR_HTTP2_GOAWAY_SESSION` for streams above it, so
 * those never reached the application; the socket-level codes mean the bytes
 * never landed at all. `ERR_HTTP2_STREAM_ERROR` is *not* in the set — most of
 * its error codes (`INTERNAL_ERROR`, say) mean the origin did see the request,
 * and replaying a POST on that basis would duplicate side effects. The one
 * exception, `REFUSED_STREAM`, is matched by message below.
 */
const RETRYABLE_CODES = new Set([
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_SOCKET_UNBOUND',
  'ECONNRESET',
  'EPIPE',
]);

/**
 * Failures that condemn the whole session rather than one stream.
 *
 * The distinction matters in both directions: a session that is gone must leave
 * the pool, and a session that is fine must **stay** — a single reset stream
 * (`ERR_HTTP2_STREAM_ERROR`, or a stream closing before its response) says
 * nothing about the connection, and discarding the connection over it would
 * throw away every other request's multiplexing for nothing.
 *
 * The set is the same as {@link RETRYABLE_CODES} today, but for a different
 * reason, so they are not one constant: "the origin never processed this" and
 * "this connection is finished" are separate questions that will diverge.
 */
const SESSION_LEVEL_CODES = new Set([
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_SOCKET_UNBOUND',
  'ECONNRESET',
  'EPIPE',
]);

/** Raised when a body stopped early. Distinct code so callers can tell it apart. */
export class UpstreamTruncatedError extends Error {
  readonly code = 'ERR_UPSTREAM_TRUNCATED';
  constructor(reason: string) {
    super(`upstream response truncated: ${reason}`);
    this.name = 'UpstreamTruncatedError';
  }
}

/**
 * Raised when h2 turns out not to be usable with an origin we believed spoke it:
 * a stale positive cache entry, an origin that negotiated something else, or a
 * handshake that never completed. All three mean "forget the verdict and take
 * the HTTP/1.1 path", which is strictly more forgiving than failing the request —
 * and if the origin is simply unreachable, the HTTP/1.1 attempt fails exactly as
 * it does today.
 */
class H2UnavailableError extends Error {
  readonly code = 'ERR_UPSTREAM_H2_UNAVAILABLE';
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : '';
}

function isRetryable(err: unknown): boolean {
  const code = errorCode(err);
  if (RETRYABLE_CODES.has(code)) return true;
  // REFUSED_STREAM is the only stream-level reset RFC 9113 §8.7 lets a client
  // retry: it guarantees the origin did no processing.
  return (
    code === 'ERR_HTTP2_STREAM_ERROR' &&
    err instanceof Error &&
    err.message.includes('REFUSED_STREAM')
  );
}

/** `host:port`, bracketing IPv6 literals so the key round-trips into a URL. */
function originKey(hostname: string, port: number): string {
  return `${net.isIPv6(hostname) ? `[${hostname}]` : hostname}:${port}`;
}

/**
 * Request headers translated for HTTP/2.
 *
 * Pseudo-headers first (HTTP/2 requires it), names lowercased, `Host` folded
 * into `:authority`, and every connection-specific header dropped. Getting this
 * wrong is not a bad response: `session.request()` throws
 * `ERR_HTTP2_INVALID_CONNECTION_HEADERS` synchronously, which is why it is a
 * separate, separately-tested function.
 */
export function toH2RequestHeaders(
  target: UpstreamTarget,
  method: string,
  headers: http.OutgoingHttpHeaders,
): http2.OutgoingHttpHeaders {
  let authority: string | undefined;
  const rest: http2.OutgoingHttpHeaders = {};

  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined) continue;
    // A pseudo-header arriving as a normal header is either an attack or a bug;
    // either way the ones below are the only pseudo-headers we send.
    if (name.startsWith(':')) continue;
    if (name === 'host') {
      if (authority === undefined) authority = String(Array.isArray(value) ? value[0] : value);
      continue;
    }
    if (H2_FORBIDDEN.has(name)) continue;
    // `TE` survives only as exactly `trailers`; anything else is forbidden.
    if (name === 'te' && String(value) !== 'trailers') continue;
    rest[name] = value as http2.OutgoingHttpHeaders[string];
  }

  const host = net.isIPv6(target.hostname) ? `[${target.hostname}]` : target.hostname;
  return {
    ':method': method,
    ':path': target.path,
    ':scheme': target.protocol,
    ':authority': authority ?? (target.port === 443 ? host : `${host}:${target.port}`),
    ...rest,
  };
}

/**
 * Response headers in the shape the HTTP/1.1 path produces.
 *
 * `:status` and any other pseudo-header are removed rather than passed through:
 * the recording layer and `writeHead` must see one format, and a literal
 * `:status` header would be rejected on the way back out to the client.
 */
export function fromH2ResponseHeaders(headers: http2.IncomingHttpHeaders): {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
} {
  const out: http.IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':')) continue;
    out[name] = value;
  }
  const raw = headers[':status'];
  const status = raw === undefined ? undefined : Number(raw);
  return { status: status === undefined || Number.isNaN(status) ? undefined : status, headers: out };
}

/**
 * Whether a response is defined to have no body, in which case a
 * `content-length` says nothing about how many bytes should arrive.
 *
 * Verifying length on these would report every `HEAD` and every `304` as
 * truncated — a false positive is as bad as a false negative here.
 */
function bodylessResponse(method: string, status: number | undefined): boolean {
  if (method.toUpperCase() === 'HEAD') return true;
  if (status === undefined) return false;
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

function declaredLength(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers['content-length'];
  if (raw === undefined || Array.isArray(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The body stream handed to callers for h2: a pass-through whose *only* clean
 * ending is one this function has verified.
 *
 * The coupling to the source is hand-written rather than `pipe`/`pipeline`, and
 * that is the whole point. Measured on Node 22.21.1, an h2 session or socket
 * dying mid-body destroys the client stream with **no error and no `end`** — and
 * `pipeline` then destroys the destination without an error too, so a consumer's
 * `for await` simply *finishes*. Seven bytes of an eight-megabyte body would look
 * like a complete response. Driving the coupling here means every way the source
 * can stop is enumerated below, and the only path that ends `out` cleanly is the
 * one that saw `end` and a matching byte count:
 *
 * Exported so those endings can be tested directly: two of them (a short
 * declared length, and a close with no `end`) are cases a cooperating
 * `node:http2` server cannot be made to produce on demand, because Node's own
 * client checks fire first or the timing is not controllable.
 *
 * - `end` with a satisfied (or absent) `content-length` → clean end, `complete`.
 * - `end` short of a declared `content-length` → destroyed with an error.
 * - `error` → destroyed with that error.
 * - `close` without `end` (session death, socket death, abort) → destroyed with
 *   an error.
 *
 * A caller therefore learns of truncation twice over: its `for await` throws
 * *and* {@link BodyStatus} says `truncated` with a reason.
 *
 * Backpressure is explicit for the same reason: a full `out` pauses the source,
 * which stops HTTP/2 window updates and blocks the origin. That is what lets the
 * exchange pipeline await `waitForDrain` on a slow client without deadlocking.
 */
export function countingBody(
  source: http2.ClientHttp2Stream,
  expectedLength: number | null,
  onSettled: (status: BodyStatus) => void,
): Readable {
  const out = new PassThrough();
  let received = 0;
  let state: BodyStatus = { state: 'pending' };

  // The recording invariant's blind spot, closed. `fail()` below destroys `out`
  // with an error, and a stream that emits 'error' with no listener is an
  // *uncaught exception* — not a rejection — so `dispatchExchange`'s `.catch()`
  // structurally cannot see it, and nothing in `src/` installs an
  // `uncaughtException` handler. The window is not theoretical: `handleExchange`
  // resolves this response, then awaits `throttle.delayLatency()` (tens to
  // hundreds of milliseconds under `laurel-proxy throttle 3g`) and only then
  // starts iterating. An origin that resets inside that window used to take the
  // proxy with it — one uncaught exception per exchange, measured against a real
  // `node:http2` origin.
  //
  // Listening changes nothing else. A consumer that arrives later still throws:
  // Node's async iterator rejects from `stream.errored`, which is recorded on the
  // stream itself rather than delivered only to whoever was listening at the time.
  // `bodyStatus()` still says `truncated`, with the same reason. The HTTP/1.1 path
  // has had the symmetric listener from the start (`h1Request` attaches
  // `res.on('error', …)`), which is the only reason it was never exposed to this.
  out.on('error', () => {});

  const complete = () => {
    state = { state: 'complete' };
    onSettled(state);
    out.end();
  };
  const fail = (reason: string) => {
    // A body already verified complete must still be *delivered*: `out` may hold
    // buffered bytes the caller has not read yet, and destroying it here would
    // turn a complete response into a truncated one on the way out.
    if (state.state === 'complete') return;
    if (state.state === 'pending') {
      state = { state: 'truncated', reason };
      onSettled(state);
    }
    if (!out.destroyed) out.destroy(new UpstreamTruncatedError(reason));
  };

  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (!out.write(chunk)) source.pause();
  });
  out.on('drain', () => source.resume());

  source.on('end', () => {
    // `end` is not proof of completion. When a session or socket dies, Node
    // closes each of its streams with `CANCEL` and then pushes `null`, so the
    // readable ends with no error at all — measured on Node 22.21.1. `rstCode`
    // is assigned in `closeStream` before that push, so it is already set here,
    // and it is the difference between "the origin finished" and "something cut
    // this off". Zero covers both a clean end and the undetectable
    // `RST_STREAM(NO_ERROR)` case documented at the top of this file.
    if (source.rstCode) {
      fail(`stream reset with code ${source.rstCode} after ${received} bytes`);
      return;
    }
    if (expectedLength !== null && received !== expectedLength) {
      fail(`expected ${expectedLength} bytes, received ${received}`);
      return;
    }
    complete();
  });

  source.on('error', (err: Error) => fail(err.message));

  // Fires after 'end' too, where the `complete` guard makes it a no-op. Without
  // 'end' it is the only notice we get that the body stopped.
  source.on('close', () => fail(`stream closed after ${received} bytes without ending`));

  // A consumer that gives up (client gone) must not leave the upstream stream
  // running: destroying the source sends RST_STREAM and frees the window.
  out.on('close', () => {
    fail('response body abandoned by the caller');
    if (!source.destroyed) source.destroy();
  });

  return out;
}

interface AlpnEntry {
  protocol: NegotiatedProtocol;
  expiresAt: number;
}

interface PooledSession {
  session: http2.ClientHttp2Session;
  /** Streams in flight, which decides whether the session may be unref'd. */
  active: number;
  /** Set on GOAWAY: no new streams here, but in-flight ones may still finish. */
  draining: boolean;
}

export class UpstreamTransport {
  private alpn = new Map<string, AlpnEntry>();
  private sessions = new Map<string, PooledSession>();
  /**
   * Probes and connects already under way, keyed like the caches they will fill.
   *
   * Without these, both {@link negotiate} and {@link acquireSession} read a map
   * and then await, so every request that arrives before the first one finishes
   * misses the cache and starts its own work: measured at 20 TCP connections and
   * 10 h2 sessions for 10 concurrent requests to a cold origin — *worse* than the
   * `node:https` code this replaced, and precisely the shape of a browser page
   * load, the burst the pooling exists for. Sharing the in-flight promise is what
   * makes the cache a cache rather than a same-request memo.
   */
  private alpnInFlight = new Map<string, Promise<NegotiatedProtocol>>();
  private sessionInFlight = new Map<string, Promise<PooledSession>>();
  private closed = false;
  private readonly opts: Required<Omit<UpstreamOptions, 'connect'>> & {
    connect: NonNullable<UpstreamOptions['connect']>;
  };

  constructor(options: UpstreamOptions = {}) {
    this.opts = {
      h2TtlMs: options.h2TtlMs ?? 10 * 60_000,
      h1TtlMs: options.h1TtlMs ?? 60_000,
      maxAlpnEntries: options.maxAlpnEntries ?? 256,
      maxSessions: options.maxSessions ?? 64,
      sessionIdleMs: options.sessionIdleMs ?? 60_000,
      probeTimeoutMs: options.probeTimeoutMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      connect: options.connect ?? ((authority, opts) => http2.connect(authority, opts)),
    };
  }

  /** Observability for tests and future diagnostics; no behaviour depends on it. */
  stats(): { alpnEntries: number; sessions: number } {
    return { alpnEntries: this.alpn.size, sessions: this.sessions.size };
  }

  /** Drops every pooled session and cached verdict. Safe to call twice. */
  close(): void {
    this.closed = true;
    for (const [key, pooled] of this.sessions) {
      this.sessions.delete(key);
      pooled.session.destroy();
    }
    this.alpn.clear();
    // In-flight work needs no cancelling: a probe socket is `unref`'d and gets
    // destroyed by its own `finish`, and a handshake that completes after this
    // sees `closed` and destroys the session it just made. Dropping the entries
    // only keeps a post-close caller from being handed a session that is gone.
    this.alpnInFlight.clear();
    this.sessionInFlight.clear();
  }

  async request(init: UpstreamRequestInit): Promise<UpstreamResponse> {
    const { target } = init;
    // Cleartext h2 (h2c) is out of scope, and without TLS there is no ALPN to
    // ask, so plain http is HTTP/1.1 by construction.
    if (target.protocol !== 'https') return this.h1Request(init);

    const key = originKey(target.hostname, target.port);
    const negotiated = await this.negotiate(key, target);
    if (negotiated !== 'h2') return this.h1Request(init);

    try {
      return await this.h2Request(key, init);
    } catch (err) {
      // A cached `h2` verdict that the origin no longer honours must not become a
      // permanent failure for that origin: forget it and take the other path.
      if (err instanceof H2UnavailableError) {
        this.alpn.delete(key);
        return this.h1Request(init);
      }
      throw err;
    }
  }

  // ---- HTTP/1.1 ------------------------------------------------------------

  /**
   * The pre-existing path, deliberately unchanged.
   *
   * The `http.IncomingMessage` is handed back as the body stream rather than
   * being wrapped: Node's HTTP/1.1 client already destroys the response with
   * `ECONNRESET` on a premature close (verified for both `content-length` and
   * chunked framing) and already tracks completeness in `res.complete`, so a
   * wrapper would add risk to a load-bearing path and buy nothing. The
   * asymmetry is internal; callers see the same interface either way.
   */
  private async h1Request(init: UpstreamRequestInit): Promise<UpstreamResponse> {
    const { target, method, headers, body } = init;
    const transport = target.protocol === 'https' ? https : http;
    const options: https.RequestOptions = {
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method,
      headers,
      // Deliberate and pre-existing: an intercepting proxy cannot verify origin
      // certificates on the user's behalf. Out of scope here.
      ...(target.protocol === 'https' ? { rejectUnauthorized: false } : {}),
    };

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = transport.request(options, resolve);
      req.on('error', reject);
      if (body.length > 0) req.write(body);
      req.end();
    });

    let failure: string | null = null;
    // Listening does not consume the error — a caller's `for await` still sees
    // it — but it does let `bodyStatus()` say what went wrong.
    res.on('error', (err: Error) => {
      failure ??= err.message;
    });

    return {
      protocol: 'http/1.1',
      status: res.statusCode,
      headers: res.headers,
      body: res,
      bodyStatus: () => {
        if (failure !== null) return { state: 'truncated', reason: failure };
        if (!res.readableEnded && !res.destroyed) return { state: 'pending' };
        if (res.complete) return { state: 'complete' };
        return { state: 'truncated', reason: 'incomplete message' };
      },
    };
  }

  // ---- ALPN ----------------------------------------------------------------

  private negotiate(key: string, target: UpstreamTarget): Promise<NegotiatedProtocol> {
    const cached = this.alpn.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) return Promise.resolve(cached.protocol);
      this.alpn.delete(key);
    }

    // A concurrent caller joins the probe already in flight rather than opening a
    // second TLS connection to ask the same question.
    const running = this.alpnInFlight.get(key);
    if (running) return running;

    const probe = (async () => {
      const probed = await this.probeAlpn(target);
      // A failed probe is not evidence about the origin's protocols — it is
      // usually the origin being unreachable. Caching it would let one bad moment
      // pin the origin, so we don't, and the HTTP/1.1 attempt that follows fails
      // exactly as it does today.
      if (probed === null) return 'http/1.1';
      this.rememberAlpn(key, probed);
      return probed;
    })();

    this.alpnInFlight.set(key, probe);
    // The verdict is cached *inside* the promise, before it settles, so anyone
    // arriving after this cleanup reads the cache instead. `then(fn, fn)` rather
    // than `finally`: the promise `finally` returns would reject on its own and
    // become the unhandled rejection this module exists to avoid.
    const forget = () => {
      if (this.alpnInFlight.get(key) === probe) this.alpnInFlight.delete(key);
    };
    probe.then(forget, forget);
    return probe;
  }

  private rememberAlpn(key: string, protocol: NegotiatedProtocol): void {
    const ttl = protocol === 'h2' ? this.opts.h2TtlMs : this.opts.h1TtlMs;
    // Re-insert so the Map's iteration order is insertion-recency, which is what
    // the eviction below consumes.
    this.alpn.delete(key);
    this.alpn.set(key, { protocol, expiresAt: Date.now() + ttl });
    while (this.alpn.size > this.opts.maxAlpnEntries) {
      const oldest = this.alpn.keys().next();
      if (oldest.done) break;
      this.alpn.delete(oldest.value);
    }
  }

  private probeAlpn(target: UpstreamTarget): Promise<NegotiatedProtocol | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: NegotiatedProtocol | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const socket = tls.connect({
        host: target.hostname,
        port: target.port,
        ALPNProtocols: ['h2', 'http/1.1'],
        // Same deliberate choice as the request path above.
        rejectUnauthorized: false,
        ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
      });
      const timer = setTimeout(() => finish(null), this.opts.probeTimeoutMs);
      // Whatever the probe costs, it must not hold the process open.
      timer.unref?.();
      socket.unref();

      socket.on('secureConnect', () => {
        finish(socket.alpnProtocol === 'h2' ? 'h2' : 'http/1.1');
      });
      socket.on('error', () => finish(null));
      socket.on('close', () => finish(null));
    });
  }

  // ---- HTTP/2 --------------------------------------------------------------

  private async h2Request(key: string, init: UpstreamRequestInit): Promise<UpstreamResponse> {
    let attempted = 0;
    for (;;) {
      const pooled = await this.acquireSession(key, init.target);
      const reused = pooled.reused;
      try {
        return await this.h2Exchange(key, pooled.entry, init);
      } catch (err) {
        if (err instanceof H2UnavailableError) throw err;
        const { session } = pooled.entry;
        // Only condemn the connection when the connection is what failed. A
        // single bad stream leaves the session pooled and multiplexing for
        // everyone else — see SESSION_LEVEL_CODES.
        if (SESSION_LEVEL_CODES.has(errorCode(err)) || session.closed || session.destroyed) {
          this.dropSession(key, session, false);
        }
        // The whole point of the retry: a session can die between the request
        // that last used it and this one, and the request that discovers the
        // corpse must not be the one that pays for it. Only once, only for a
        // reused session, and only for failures that prove the origin never saw
        // the request — see RETRYABLE_CODES.
        if (reused && attempted === 0 && isRetryable(err)) {
          attempted += 1;
          continue;
        }
        throw err;
      }
    }
  }

  private h2Exchange(
    key: string,
    entry: PooledSession,
    init: UpstreamRequestInit,
  ): Promise<UpstreamResponse> {
    const { target, method, headers, body } = init;
    return new Promise<UpstreamResponse>((resolve, reject) => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = entry.session.request(toH2RequestHeaders(target, method, headers));
      } catch (err) {
        reject(err);
        return;
      }

      entry.active += 1;
      entry.session.ref();
      let handedOff = false;
      const release = () => {
        entry.active -= 1;
        if (entry.active === 0) {
          // Idle sessions must not keep a CLI process alive.
          entry.session.unref();
          if (entry.draining) this.dropSession(key, entry.session, true);
        }
      };
      stream.once('close', release);

      // Errors before the response belong to this promise; after it they belong
      // to the body stream, where `countingBody` is already watching for them.
      // This listener stays attached either way, so a late error can never be an
      // unhandled 'error' event — which would end the process.
      stream.on('error', (err: Error) => {
        if (!handedOff) reject(err);
      });
      // A close without a response is always a failure, whatever the reset code.
      // Some codes (`NO_ERROR`, `CANCEL`) do not produce an 'error' event at all,
      // so without this the promise would simply never settle.
      stream.once('close', () => {
        if (!handedOff) {
          reject(new UpstreamTruncatedError(
            `stream closed before a response arrived (rst ${stream.rstCode})`,
          ));
        }
      });

      stream.once('response', (raw: http2.IncomingHttpHeaders) => {
        const { status, headers: resHeaders } = fromH2ResponseHeaders(raw);
        let bodyState: BodyStatus = { state: 'pending' };
        const expected = bodylessResponse(method, status) ? null : declaredLength(resHeaders);
        const bodyStream = countingBody(stream, expected, (settled) => {
          bodyState = settled;
        });
        handedOff = true;
        resolve({
          protocol: 'h2',
          status,
          headers: resHeaders,
          body: bodyStream,
          bodyStatus: () => bodyState,
        });
      });

      if (body.length > 0) stream.end(body);
      else stream.end();
    });
  }

  private async acquireSession(
    key: string,
    target: UpstreamTarget,
  ): Promise<{ entry: PooledSession; reused: boolean }> {
    const pooled = this.sessions.get(key);
    if (pooled) {
      if (!pooled.session.closed && !pooled.session.destroyed && !pooled.draining) {
        // Re-insert to keep iteration order LRU for eviction.
        this.sessions.delete(key);
        this.sessions.set(key, pooled);
        return { entry: pooled, reused: true };
      }
      this.dropSession(key, pooled.session, false);
    }

    // One handshake per cold origin, shared by everyone who wants it. `reused`
    // stays false for all of them, which is the honest answer: a brand-new
    // session that fails is not the stale-corpse case the retry exists for.
    const running = this.sessionInFlight.get(key);
    if (running) return { entry: await running, reused: false };

    const connecting = this.connectSession(key, target);
    this.sessionInFlight.set(key, connecting);
    const forget = () => {
      if (this.sessionInFlight.get(key) === connecting) this.sessionInFlight.delete(key);
    };
    connecting.then(forget, forget);
    return { entry: await connecting, reused: false };
  }

  private connectSession(key: string, target: UpstreamTarget): Promise<PooledSession> {
    return new Promise<PooledSession>((resolve, reject) => {
      const authority = `https://${originKey(target.hostname, target.port)}`;
      let session: http2.ClientHttp2Session;
      try {
        session = this.opts.connect(authority, {
          // Same deliberate choice as the HTTP/1.1 path.
          rejectUnauthorized: false,
          ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
        });
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        session.destroy();
        reject(new H2UnavailableError(`h2 handshake to ${key} timed out`));
      }, this.opts.connectTimeoutMs);
      timer.unref?.();

      // An unhandled 'error' on a session ends the process, and a pooled session
      // outlives every request that used it — so this is attached for the
      // session's whole life, not just the handshake.
      session.on('error', (err: Error) => {
        this.dropSession(key, session, false);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A stale positive lands here: `http2.connect` offers only `h2`, so an
        // origin that has stopped supporting it fails the TLS handshake with
        // NO_APPLICATION_PROTOCOL rather than negotiating something else.
        reject(errorCode(err).includes('ALERT_NO_APPLICATION_PROTOCOL')
          ? new H2UnavailableError(`origin ${key} no longer offers h2`)
          : err);
      });
      session.on('close', () => this.dropSession(key, session, false));
      // GOAWAY means no *new* streams, while in-flight ones may still finish. So
      // the session leaves the pool but is not destroyed; `release` disposes of
      // it once the last stream is done. Callers of in-flight streams see their
      // response through to the end — or an error, if the origin cuts it short.
      session.on('goaway', () => {
        const entry = this.sessions.get(key);
        if (entry?.session === session) {
          entry.draining = true;
          this.sessions.delete(key);
        }
      });
      session.setTimeout(this.opts.sessionIdleMs, () => {
        this.dropSession(key, session, true);
      });

      session.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session.alpnProtocol !== 'h2') {
          session.destroy();
          reject(new H2UnavailableError(`origin ${key} negotiated ${String(session.alpnProtocol)}`));
          return;
        }
        const entry: PooledSession = { session, active: 0, draining: false };
        this.evictIfFull();
        // Whatever is being displaced has to be closed on the way out. `set`
        // alone drops the previous entry's only reference, putting a live session
        // beyond the reach of the map `close()` iterates — a leak that keeps
        // origin sockets open and hangs `Http2Server.close()` in a consumer's
        // test harness. Graceful, because a displaced session may still have
        // streams in flight and they are entitled to finish; the same choice
        // `evictIfFull` makes. The in-flight map above should make this
        // unreachable for concurrent cold starts, which is exactly why it is
        // handled rather than assumed away.
        const displaced = this.sessions.get(key);
        if (displaced && displaced.session !== session) {
          this.sessions.delete(key);
          if (!displaced.session.destroyed) displaced.session.close();
        }
        this.sessions.set(key, entry);
        if (this.closed) {
          // `close()` raced this handshake; do not leave a live session behind.
          this.sessions.delete(key);
          session.destroy();
          reject(new Error('upstream transport closed'));
          return;
        }
        session.unref();
        resolve(entry);
      });
    });
  }

  /** Removes a session from the pool, gracefully or by force. */
  private dropSession(key: string, session: http2.ClientHttp2Session, graceful: boolean): void {
    const entry = this.sessions.get(key);
    if (entry?.session === session) this.sessions.delete(key);
    if (session.destroyed) return;
    if (graceful) session.close();
    else session.destroy();
  }

  private evictIfFull(): void {
    while (this.sessions.size >= this.opts.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      const entry = this.sessions.get(oldest.value);
      this.sessions.delete(oldest.value);
      // Graceful: an evicted session may still have streams in flight, and
      // `close()` lets them finish while refusing new ones.
      if (entry && !entry.session.destroyed) entry.session.close();
    }
  }
}
