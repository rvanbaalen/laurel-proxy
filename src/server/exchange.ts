import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { isGone, waitForDrain } from './stream-utils.js';
import type { DrainableStream } from './stream-utils.js';
import { recordSafely } from '../shared/never-fatal.js';
import { UpstreamTransport } from './upstream.js';
import type { NegotiatedProtocol, UpstreamResponse } from './upstream.js';
import type { Config, RequestRecord } from '../shared/types.js';
import type { Throttler } from './throttle.js';

export interface ExchangeTarget {
  hostname: string;
  port: number;
  protocol: 'http' | 'https';
  url: string;
  path: string;
}

/**
 * The slice of an inbound request this pipeline reads.
 *
 * Structural rather than `http.IncomingMessage` because HTTP/2 arrives as an
 * `Http2ServerRequest`, which is **not** a subclass of it — Node's compatibility
 * API is a separate class that deliberately mirrors the shape. Nominal typing
 * would force either a cast or a duplicated pipeline; naming the four members
 * actually used means both classes satisfy it on their own terms, and anything
 * this pipeline starts depending on has to be added here first.
 *
 * `method` and `url` are optional because `http.IncomingMessage` declares them
 * so (a server-side message always has them in practice, but the type does not
 * say that); `Http2ServerRequest` declares them required, which is assignable.
 */
export interface ExchangeRequest extends AsyncIterable<Buffer> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: http.IncomingHttpHeaders;
  /**
   * The HTTP/2 stream behind an `Http2ServerRequest`, absent for HTTP/1.1.
   *
   * Named here because an h2 request can stop being a request without the body
   * iteration saying so. `Http2ServerRequest` is a wrapper: when the client sends
   * `RST_STREAM`, Node's compatibility layer pushes `null` into it, so a
   * `for await` over a half-received body can simply *finish*. On Node 22.21.1
   * the async iterator's own premature-close detection does throw for a reset
   * mid-body, but that is a property of the iterator, not of the request — and it
   * cannot possibly fire for a body that arrived in full before the client gave
   * up. `stream.destroyed` is the direct question, and it is the reason a
   * cancelled h2 stream is never recorded as a completed exchange.
   *
   * Deliberately not `aborted`, which both classes do expose: on
   * `http.IncomingMessage` it is a deprecated getter (DEP0170) that prints a
   * process warning when touched, and the HTTP/1.1 path must not start emitting
   * one per request.
   */
  readonly stream?: { readonly destroyed: boolean } | undefined;
}

/**
 * The slice of an outbound response this pipeline writes.
 *
 * Same reasoning as {@link ExchangeRequest}: `Http2ServerResponse` is a separate
 * class from `http.ServerResponse`, so the seam has to be structural. It extends
 * {@link DrainableStream} because backpressure is part of the surface — the relay
 * awaits `waitForDrain(clientRes)` — and that interface already exists for the
 * same reason on the WebSocket side.
 *
 * `end` is two overloads rather than one optional parameter on purpose: with a
 * single `end(data?: string)` neither class's overload set is assignable to it,
 * since `end(cb?)` and `end(chunk, cb?)` are distinct signatures and TypeScript
 * matches the whole thing at once.
 *
 * The inherited `destroyed` is `boolean | undefined` because an
 * `Http2ServerResponse` genuinely does not have it at runtime — see
 * `DrainableStream`. Ask `isGone()` rather than reading it directly; it is the
 * one place that knows to fall through to `stream.destroyed` for h2.
 */
export interface ExchangeResponse extends DrainableStream {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(statusCode: number, headers?: http.OutgoingHttpHeaders): unknown;
  write(chunk: Buffer): boolean;
  end(): unknown;
  end(data: string): unknown;
  destroy(error?: Error): unknown;
}

/**
 * The one method the pipeline needs from `UpstreamTransport`.
 *
 * Narrow deliberately: a pooled session and an ALPN cache have a lifecycle, and
 * it belongs to whoever created the transport (`ProxyServer`, which closes it in
 * `stop()`). Handing the exchange the whole class would let a future edit call
 * `close()` from inside a single exchange and tear the pool out from under every
 * other one. It also keeps the dependency stubbable — the class has private
 * fields, so a test double could not satisfy the class type.
 */
export type UpstreamRequester = Pick<UpstreamTransport, 'request'>;

export interface ExchangeDeps {
  config: Config;
  onRecord: (record: RequestRecord) => void;
  throttle?: Throttler;
  /**
   * Upstream transport, owned and closed by the caller. Optional so that
   * `handleExchange` stays callable with just a config and a sink; see
   * {@link sharedUpstream} for what an omitted one falls back to.
   */
  upstream?: UpstreamRequester;
  /**
   * Wire protocol negotiated with the client; decides how upstream headers relay
   * back, independent of the origin's own protocol. Passed in by the
   * caller; omitting it means HTTP/1.1.
   */
  clientProtocol?: NegotiatedProtocol;
}

let fallbackTransport: UpstreamTransport | null = null;

/**
 * The transport used when `deps.upstream` is omitted.
 *
 * `ProxyServer` always supplies its own and closes it in `stop()`. This exists
 * for the callers that have no lifecycle to hang one on, so that they neither
 * have to fake one nor pay for a fresh ALPN probe and a fresh session pool on
 * every request. Nothing closes it, which is safe rather than sloppy: it holds
 * nothing at all until an origin negotiates h2, and every pooled session is
 * `unref`'d and idles itself out, so it can neither keep a process alive nor
 * grow without bound.
 */
function sharedUpstream(): UpstreamTransport {
  fallbackTransport ??= new UpstreamTransport();
  return fallbackTransport;
}

/** Hop-by-hop headers that must not be forwarded upstream. */
const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization'];

/**
 * Resolves a plain-HTTP proxy request's absolute-form URL into an
 * {@link ExchangeTarget}. Returns null for anything not `http:`.
 *
 * @param rawUrl - The absolute-form request URL, e.g. `http://host/path`.
 * @returns The resolved target, or null if `rawUrl` isn't a valid `http:` URL.
 */
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

/**
 * Resolves an intercepted HTTPS request into an {@link ExchangeTarget}. Always
 * `https:` — mitm-only.
 *
 * @param hostname - The TLS SNI/CONNECT hostname.
 * @param port - The TLS CONNECT port.
 * @param rawPath - The request path plus query string.
 * @returns The resolved target.
 */
export function resolveMitmTarget(hostname: string, port: number, rawPath: string): ExchangeTarget {
  // Non-default port must stay in the recorded URL — omitting it makes replay
  // (HTTP Repeater, WebSocket replay) silently target 443 instead.
  const authority = port === 443 ? hostname : `${hostname}:${port}`;
  return {
    hostname,
    port,
    protocol: 'https',
    url: `https://${authority}${rawPath}`,
    path: rawPath,
  };
}

/**
 * The status to put on the wire for an upstream response.
 *
 * Node's HTTP *client* parser and its HTTP *server* writer do not agree on what
 * a status code may be. The parser accepts any three-digit status line, so
 * `HTTP/1.1 000` arrives as `statusCode === 0`; the writer rejects anything
 * outside 100–999 with a `RangeError [ERR_HTTP_INVALID_STATUS_CODE]`. Forwarding
 * the parsed value verbatim therefore throws out of an exchange nobody is
 * awaiting, which on Node 22 is a process exit — over one malformed byte from
 * upstream.
 *
 * A clamp rather than `|| 500`: `||` only rescues `0`, and every other
 * unsendable value the parser can produce (`HTTP/1.1 042` → `42`) would still
 * throw. This substitutes a status only for what cannot be sent, and only on the
 * wire — the record keeps the upstream response's own `status` as upstream stated
 * it, so a capture of a malformed response stays an accurate capture.
 *
 * **What is sendable depends on the client's protocol**, which is why this takes
 * one. `Http2ServerResponse.writeHead` is stricter than the HTTP/1.1 writer in
 * both directions: measured on Node 22.21.1, it throws `ERR_HTTP2_STATUS_INVALID`
 * for `600`, `700`, `999` **and for every 1xx** — `100`, `101`, `102` and `199`
 * all — while `599` is fine. So the h2 range is 200–599, not the 100–999 an
 * HTTP/1.1 client accepts. (HTTP/2 has no `101`: the protocol carries no
 * `Upgrade`, and informational responses go out through `additionalHeaders`, not
 * a final status.) An unclamped 6xx origin status relayed to an h2 client throws
 * out of the pipeline — `failExchange` then answers 502, leaving the h2 upstream
 * body unconsumed.
 *
 * The HTTP/1.1 branch, default included, is unchanged, so every call site that
 * omits `clientProtocol` keeps its exact meaning.
 */
export function sendableStatus(
  statusCode: number | undefined,
  clientProtocol: NegotiatedProtocol = 'http/1.1',
): number {
  if (statusCode === undefined || !Number.isInteger(statusCode)) return 500;
  if (clientProtocol === 'h2') return statusCode >= 200 && statusCode <= 599 ? statusCode : 500;
  return statusCode >= 100 && statusCode <= 999 ? statusCode : 500;
}

/**
 * Headers HTTP/2 forbids on any message, so they can never be relayed to an
 * h2 client — `writeHead` throws `ERR_HTTP2_INVALID_CONNECTION_HEADERS`
 * rather than silently dropping them.
 */
const H2_FORBIDDEN_RESPONSE_HEADERS = [
  'connection',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'upgrade',
  'http2-settings',
];

/**
 * Upstream's response headers, adjusted for the protocol the client is on.
 *
 * The framing header goes in both cases and for the same reason: we re-frame the
 * response ourselves. If upstream gave no `content-length` either (it used
 * chunked encoding), Node re-introduces `Transfer-Encoding: chunked` as we
 * stream — correct proxy behaviour, since we genuinely are chunking, and it keeps
 * the connection reusable for keep-alive. Forcing `connection: close` instead is
 * a regression the integration suite pins against.
 *
 * Everything *else* upstream said reaches an HTTP/1.1 client untouched and by
 * design: stripping `connection` for h1.1 too would look harmless but would
 * quietly convert an upstream `connection: close` into a kept-alive client
 * connection.
 *
 * For an h2 client the connection-specific headers cannot be relayed at all, so
 * they are dropped — the protocol carries that information in frames instead.
 * The parameter is how the two cases stay one function with one place to look:
 * the caller says which client it is talking to, and the h1.1 default covers
 * every call site that doesn't specify one.
 */
export function relayResponseHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
  clientProtocol: NegotiatedProtocol = 'http/1.1',
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...upstreamHeaders };
  delete headers['transfer-encoding'];
  if (clientProtocol === 'h2') {
    for (const name of H2_FORBIDDEN_RESPONSE_HEADERS) delete headers[name];
    // `TE` survives into HTTP/2 only as exactly `trailers`.
    if (headers.te !== undefined && String(headers.te) !== 'trailers') delete headers.te;
  }
  return headers;
}

/**
 * Answers — or gives up on — a client whose exchange threw somewhere the
 * pipeline did not expect.
 *
 * `handleExchange` is dispatched with `void`, so a rejection reaches no caller
 * and Node 22 ends the process. Catching it at the dispatch site converts that
 * class of process exits into a class of lost exchanges, but only half the
 * problem is the process: the client is still holding a socket that will never
 * be written to, and would sit there until its own timeout. So the catch also
 * closes the response out — a 502 while a status line can still be sent,
 * otherwise a reset, which is the only remaining way to tell a client that the
 * body it is reading will not be completed.
 *
 * Its own failures are swallowed: a throw from inside a `.catch()` handler is
 * another unhandled rejection, i.e. the exact thing this exists to prevent.
 */
export function failExchange(clientRes: ExchangeResponse): void {
  try {
    // Uses `isGone`, not `clientRes.destroyed` — that property doesn't exist on
    // `Http2ServerResponse`; `isGone` falls through to `res.stream` for h2.
    if (clientRes.writableEnded || isGone(clientRes)) return;
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end('Bad Gateway');
      return;
    }
    clientRes.destroy();
  } catch {
    // Nothing left to try, and no logging channel in this codebase to say so.
  }
}

/**
 * Buffers a request body via async iteration — the one consumption style shared
 * by `http.IncomingMessage` and `Http2ServerRequest`. Rejects on a
 * stream error; never hangs on an already-ended stream.
 */
async function readBody(stream: ExchangeRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Whether an HTTP/2 client has abandoned this exchange.
 *
 * `false` for HTTP/1.1, always and by construction: neither
 * `http.IncomingMessage` nor `http.ServerResponse` has a `stream`, so this
 * question changes nothing about what an HTTP/1.1 client observes. There, a
 * client that goes away makes the next `write` throw, and the relay's own `catch`
 * is what notices.
 *
 * HTTP/2 needs asking explicitly because none of the usual signals fire. A
 * `RST_STREAM` makes Node's compatibility layer push `null` into the request (so
 * body iteration *ends*, cleanly), while `Http2ServerResponse.writeHead` and
 * `end` are both silent no-ops on a closed stream. An exchange whose client
 * cancelled after sending a complete request, against an origin that answers with
 * no body, therefore produces no error anywhere and an upstream response that
 * genuinely was complete — and would be recorded as a clean 204 that the client
 * never saw. Measured on Node 22.21.1.
 *
 * Both objects are consulted although they wrap one `ServerHttp2Stream`: which of
 * the two a caller has to hand differs by call site, and a future change that
 * gives them different lifetimes should not silently lose the check.
 */
function h2ClientGone(clientReq: ExchangeRequest, clientRes: ExchangeResponse): boolean {
  return clientReq.stream?.destroyed === true || clientRes.stream?.destroyed === true;
}

/**
 * Relays one client request to `target` upstream and its response back, applying
 * throttling and capturing both bodies, then records the exchange via
 * `deps.onRecord` once it is known to have completed.
 *
 * @param clientReq - The inbound request.
 * @param clientRes - The response stream to write the relayed answer to.
 * @param target - Where to send the request.
 * @param deps - Config, the throttle, the upstream transport, and the record sink.
 */
export async function handleExchange(
  clientReq: ExchangeRequest,
  clientRes: ExchangeResponse,
  target: ExchangeTarget,
  deps: ExchangeDeps,
): Promise<void> {
  const startTime = Date.now();
  const { config } = deps;

  let requestBody: Buffer;
  try {
    requestBody = await readBody(clientReq);
  } catch {
    return;
  }

  // Client already gone — skip forwarding so a cancelled request's side effects
  // aren't replayed on the origin. Best-effort and HTTP/2-only; see {@link h2ClientGone}.
  if (h2ClientGone(clientReq, clientRes)) return;

  const upstreamHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
  for (const name of HOP_BY_HOP) delete upstreamHeaders[name];
  // HTTP/2 pseudo-headers (`:method`, `:path`, etc.) land in `.headers` but
  // aren't real headers — forwarding one throws on an HTTP/1.1 origin. The
  // record keeps `clientReq.headers` untouched, so the capture is unaffected.
  for (const name of Object.keys(upstreamHeaders)) {
    if (name.startsWith(':')) delete upstreamHeaders[name];
  }
  // Ask upstream for an uncompressed body so no decompression path is needed.
  delete upstreamHeaders['accept-encoding'];
  if (target.protocol === 'https') upstreamHeaders.host = target.hostname;

  // Awaited plainly rather than chained off `?.`, so an absent/disabled
  // throttle is a no-op — see Throttler.
  if (requestBody.length > 0) {
    await deps.throttle?.up.consume(requestBody.length);
  }

  let proxyRes: UpstreamResponse;
  try {
    // Protocol negotiation (h2 vs HTTP/1.1 via ALPN) is the transport's concern;
    // it returns one shape either way.
    proxyRes = await (deps.upstream ?? sharedUpstream()).request({
      target,
      // Mirrors Node's own default for an absent method, to satisfy a required field.
      method: clientReq.method ?? 'GET',
      headers: upstreamHeaders,
      body: requestBody,
    });
  } catch {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end('Bad Gateway');
    }
    return;
  }

  // A throw before the relay loop below leaks the upstream body; for HTTP/2 it
  // also holds the flow-control window open via `countingBody`, blocking the
  // session's graceful idle close. Destroyed in the catch below.
  try {
    // Latency runs once here, before the first response byte — not per-chunk
    // in the streaming loop below.
    await deps.throttle?.delayLatency();

    // The status on the wire is coerced to what a response writer will accept; the
    // record below keeps what upstream actually said. See `sendableStatus`.
    clientRes.writeHead(
      sendableStatus(proxyRes.status, deps.clientProtocol),
      relayResponseHeaders(proxyRes.headers, deps.clientProtocol),
    );
  } catch (err) {
    // Rethrown so the dispatch site still answers with a 502; the body is
    // destroyed first so it isn't leaked.
    proxyRes.body.destroy();
    throw err;
  }

  const captured: Buffer[] = [];
  let capturedLength = 0;
  let responseSize = 0;

  let relayFailed = false;
  try {
    for await (const chunk of proxyRes.body as AsyncIterable<Buffer>) {
      // Wrapped so a bookkeeping failure can't abort an otherwise-healthy transfer.
      recordSafely(() => {
        responseSize += chunk.length;
        if (capturedLength < config.maxBodySize) {
          const slice = chunk.subarray(0, config.maxBodySize - capturedLength);
          captured.push(slice);
          capturedLength += slice.length;
        }
      });
      await deps.throttle?.down.consume(chunk.length);
      if (!clientRes.write(chunk)) await waitForDrain(clientRes);
    }
    clientRes.end();
  } catch {
    clientRes.destroy();
    relayFailed = true;
  }

  // None of these three implies the others, so all three guard against recording
  // a partial transfer as complete: a client h2 reset, an upstream body that
  // `bodyStatus()` saw end early, or a client write that threw (`relayFailed`).
  if (
    relayFailed ||
    h2ClientGone(clientReq, clientRes) ||
    proxyRes.bodyStatus().state !== 'complete'
  ) {
    return;
  }

  // Record built entirely inside the guard: an argument expression would evaluate
  // before entry, and this fire-and-forget call has no caller to catch a throw.
  recordSafely(() => {
    const responseBody = Buffer.concat(captured);
    const truncated =
      requestBody.length > config.maxBodySize || responseSize > config.maxBodySize;
    const contentType =
      (proxyRes.headers['content-type'] || '').split(';')[0].trim() || null;

    deps.onRecord({
      id: randomUUID(),
      timestamp: startTime,
      method: clientReq.method || 'GET',
      url: target.url,
      host: target.hostname,
      path: target.path,
      protocol: target.protocol,
      request_headers: JSON.stringify(clientReq.headers),
      request_body:
        requestBody.length > 0 ? requestBody.subarray(0, config.maxBodySize) : null,
      request_size: requestBody.length,
      status: proxyRes.status ?? 0,
      response_headers: JSON.stringify(proxyRes.headers),
      response_body: responseBody.length > 0 ? responseBody : null,
      response_size: responseSize,
      duration: Date.now() - startTime,
      content_type: contentType,
      truncated: truncated ? 1 : 0,
      // Both hops are definite here: client protocol comes from ALPN negotiation
      // (default HTTP/1.1 for callers that don't specify one), origin protocol
      // from the transport's own verdict — neither is ever stored as null.
      client_protocol: deps.clientProtocol ?? 'http/1.1',
      origin_protocol: proxyRes.protocol,
    });
  });
}
