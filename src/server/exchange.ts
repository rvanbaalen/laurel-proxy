import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { waitForDrain } from './stream-utils.js';
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
 * `DrainableStream`. Treat it as a fast path, never as proof that a response is
 * still writable.
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
  // Include a non-default port in the recorded URL. Omitting it makes replay of
  // any non-443 HTTPS capture silently target 443 — both for the HTTP Repeater
  // and for WebSocket replay, which derive their target from this URL.
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
 */
export function sendableStatus(statusCode: number | undefined): number {
  if (statusCode === undefined || !Number.isInteger(statusCode)) return 500;
  return statusCode >= 100 && statusCode <= 999 ? statusCode : 500;
}

/**
 * Headers HTTP/2 forbids on any message, so they can never be relayed to an h2
 * client. `writeHead` on an `Http2ServerResponse` does not ignore them — Node's
 * `mapToHeaders` throws `ERR_HTTP2_INVALID_CONNECTION_HEADERS`, out of an
 * exchange nobody awaits.
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
 * Everything *else* upstream said reaches an HTTP/1.1 client untouched, which is
 * the pre-existing behaviour and is deliberately preserved: stripping `connection`
 * for h1.1 too would look harmless but would quietly convert an upstream
 * `connection: close` into a kept-alive client connection.
 *
 * For an h2 client the connection-specific headers cannot be relayed at all, so
 * they are dropped — the protocol carries that information in frames instead.
 * The parameter is how the two cases stay one function with one place to look:
 * the caller says which client it is talking to, and the h1.1 default keeps every
 * existing call site meaning exactly what it did before.
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
    if (clientRes.writableEnded || clientRes.destroyed) return;
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
 * Buffers a request body.
 *
 * Async iteration rather than `on('data')`/`on('end')`: it is the one consumption
 * style both `http.IncomingMessage` and `Http2ServerRequest` offer through the
 * same member, so it is what {@link ExchangeRequest} can require. It rejects on a
 * stream error exactly as the event form did, and it cannot hang on a stream that
 * ended before this was called.
 */
async function readBody(stream: ExchangeRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

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

  const upstreamHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
  for (const name of HOP_BY_HOP) delete upstreamHeaders[name];
  // Ask upstream for an uncompressed body so no decompression path is needed.
  delete upstreamHeaders['accept-encoding'];
  if (target.protocol === 'https') upstreamHeaders.host = target.hostname;

  // Pace the upload before sending the body upstream. Awaiting here (rather
  // than chaining off an optionally-chained call) means this degrades to a
  // plain no-op await when throttling is absent or disabled — see Throttler.
  if (requestBody.length > 0) {
    await deps.throttle?.up.consume(requestBody.length);
  }

  let proxyRes: UpstreamResponse;
  try {
    // Which wire protocol this speaks is the transport's business, not the
    // pipeline's: it negotiates h2 or HTTP/1.1 with the origin via ALPN and
    // returns one shape either way.
    proxyRes = await (deps.upstream ?? sharedUpstream()).request({
      target,
      // Node's HTTP client defaults an absent method to GET, so spelling that
      // default here keeps the behaviour while satisfying a required field.
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

  // Inject configured latency once per exchange, before the first response
  // byte reaches the client — this must not run per-chunk inside the
  // streaming loop below.
  await deps.throttle?.delayLatency();

  // The status on the wire is coerced to what a response writer will accept; the
  // record below keeps what upstream actually said. See `sendableStatus`.
  clientRes.writeHead(sendableStatus(proxyRes.status), relayResponseHeaders(proxyRes.headers));

  const captured: Buffer[] = [];
  let capturedLength = 0;
  let responseSize = 0;

  let relayFailed = false;
  try {
    for await (const chunk of proxyRes.body as AsyncIterable<Buffer>) {
      // Guarded because this `try`'s catch destroys the client response: without
      // it, a failure in the capture bookkeeping would abort a transfer that is
      // otherwise proceeding perfectly.
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

  // A response that failed or was aborted mid-transfer must not be recorded as
  // if it completed — a partial body with status 200 would be actively
  // misleading for the network failures this proxy exists to diagnose.
  //
  // Two independent signals, and both are consulted because neither implies the
  // other. `bodyStatus()` is the transport's own verdict on the response, and it
  // catches endings a `for await` cannot see: HTTP/2 hands a body that stops
  // early to its consumer as a *clean* end (see `upstream.ts`), so the loop above
  // can finish normally on a body that was cut short. `relayFailed` covers the
  // converse — the body arrived in full but writing it to the client threw — where
  // the transport is entitled to say `complete` and the client still got a partial
  // response. Recording only when nothing objected keeps this the strict superset
  // of the previous `streamFailed` check that a no-behaviour-change refactor needs.
  if (relayFailed || proxyRes.bodyStatus().state !== 'complete') return;

  // Everything the record is made of is built inside the guard, not passed into
  // it. `handleExchange` is dispatched as `void handleExchange(...)`, so its
  // rejection has no caller and Node 22 turns it into a process exit; and an
  // argument expression would be evaluated before the guard was entered, which
  // is how a total boundary quietly decays into one that merely happens to hold.
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
    });
  });
}
