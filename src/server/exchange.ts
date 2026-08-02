import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { waitForDrain } from './stream-utils.js';
import { recordSafely } from './recording-safety.js';
import type { Config, RequestRecord } from '../shared/types.js';
import type { Throttler } from './throttle.js';

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
  throttle?: Throttler;
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

  // Pace the upload before sending the body upstream. Awaiting here (rather
  // than chaining off an optionally-chained call) means this degrades to a
  // plain no-op await when throttling is absent or disabled — see Throttler.
  if (requestBody.length > 0) {
    await deps.throttle?.up.consume(requestBody.length);
  }

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

  // Inject configured latency once per exchange, before the first response
  // byte reaches the client — this must not run per-chunk inside the
  // streaming loop below.
  await deps.throttle?.delayLatency();

  const resHeaders = { ...proxyRes.headers };
  // Strip upstream's framing header; we re-frame the response ourselves. If
  // upstream gave us no content-length either (e.g. it used chunked
  // encoding), Node will automatically re-introduce Transfer-Encoding:
  // chunked as we stream — that's correct proxy behaviour (we genuinely are
  // chunking) and keeps the connection reusable for keep-alive.
  delete resHeaders['transfer-encoding'];
  clientRes.writeHead(proxyRes.statusCode ?? 500, resHeaders);

  const captured: Buffer[] = [];
  let capturedLength = 0;
  let responseSize = 0;

  let streamFailed = false;
  try {
    for await (const chunk of proxyRes as AsyncIterable<Buffer>) {
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
    streamFailed = true;
  }

  // A response that failed or was aborted mid-transfer must not be recorded
  // as if it completed — a partial body with status 200 would be actively
  // misleading for the network failures this proxy exists to diagnose.
  if (streamFailed) return;

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
      status: proxyRes.statusCode ?? 0,
      response_headers: JSON.stringify(proxyRes.headers),
      response_body: responseBody.length > 0 ? responseBody : null,
      response_size: responseSize,
      duration: Date.now() - startTime,
      content_type: contentType,
      truncated: truncated ? 1 : 0,
    });
  });
}
