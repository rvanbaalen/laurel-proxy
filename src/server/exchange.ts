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
    streamFailed = true;
  }

  // A response that failed or was aborted mid-transfer must not be recorded
  // as if it completed — a partial body with status 200 would be actively
  // misleading for the network failures this proxy exists to diagnose.
  if (streamFailed) return;

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
}
