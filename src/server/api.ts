import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import type { Database } from '../storage/db.js';
import type { EventManager } from './events.js';
import type { RequestFilter, RequestRecord, WebSocketMessage } from '../shared/types.js';
import type { CertificateAuthority } from './ssl.js';
import type { ReplayRequest } from '../shared/types.js';
import { replay } from './replay.js';
import { replayWebSocket, recordToWsReplayRequest, isReplayableFrame } from './ws-replay.js';
import type { WsReplayFrame, WsReplayRequest } from '../shared/types.js';
import { enableSystemProxy, disableSystemProxy, checkSystemProxyStatus } from '../cli/system-proxy.js';
import type { Throttler } from './throttle.js';
import { THROTTLE_PRESETS, validateThrottleSettings } from './throttle.js';
import type { ThrottleSettingsInput } from './throttle.js';
import { saveThrottleSettings } from './config.js';
import type { ThrottleSettings } from '../shared/types.js';

/** Shape of a PUT /throttle body before it has been validated. */
interface ThrottlePutBody {
  preset?: unknown;
  enabled?: unknown;
  downKbps?: unknown;
  upKbps?: unknown;
  latencyMs?: unknown;
}

/** Serializes a request record for JSON output, base64-encoding its binary body fields. */
function serializeRecord(r: RequestRecord): Record<string, unknown> {
  return {
    ...r,
    request_body: r.request_body ? Buffer.from(r.request_body).toString('base64') : null,
    response_body: r.response_body ? Buffer.from(r.response_body).toString('base64') : null,
  };
}

/**
 * `m.payload` is truthy for both a populated and a zero-length Buffer, so
 * an empty payload base64-encodes to '' and only a genuinely absent
 * (null) payload stays null.
 */
function serializeWsMessage(m: WebSocketMessage): Record<string, unknown> {
  return {
    ...m,
    payload: m.payload ? Buffer.from(m.payload).toString('base64') : null,
  };
}

/**
 * Returns the parsed value, `fallback` when absent, or null when invalid.
 * `0` is deliberately valid and distinct from absent, matching how
 * `?limit=0` means zero rows and `?offset=0` means start-of-list.
 */
function parsePositiveInt(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Frames a single replay will send, from either request form. */
const MAX_REPLAY_FRAMES = 10_000;

/**
 * Standard base64 — correct alphabet, length, and padding. `Buffer.from(s,
 * 'base64')` silently discards unrecognised characters, so a malformed
 * payload would decode to arbitrary bytes and replay as garbage.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Validates client-supplied replay frames, checking everything upfront rather
 * than failing mid-send — a bad opcode or oversized list would otherwise
 * surface as a 200 that blames the connection.
 */
function parseWsReplayFrames(raw: unknown): { frames: WsReplayFrame[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: 'frames must be an array' };
  }
  // Checked before the per-frame pass, so an over-long list is reported as such
  // whatever its contents look like.
  if (raw.length > MAX_REPLAY_FRAMES) {
    return { error: `Too many frames: ${raw.length}; replay handles at most ${MAX_REPLAY_FRAMES}` };
  }

  const frames: WsReplayFrame[] = [];
  for (const frame of raw as Partial<WsReplayFrame>[]) {
    if (frame?.opcode !== 'text' && frame?.opcode !== 'binary') {
      return { error: 'Each frame needs an opcode of "text" or "binary"' };
    }
    if (typeof frame.payload !== 'string' || !BASE64.test(frame.payload)) {
      return { error: 'Each frame needs a base64-encoded payload string' };
    }
    const delayMs = frame.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return { error: 'Each frame needs a non-negative delayMs' };
    }
    frames.push({ opcode: frame.opcode, payload: frame.payload, delayMs });
  }
  return { frames };
}

/** Callbacks the API router uses to control the underlying proxy process. */
export interface ProxyControl {
  getProxyRunning: () => boolean;
  getProxyPort: () => number;
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;
}

/** Builds the Express router wiring every REST endpoint to `db`, `events`, and the proxy/throttle controls. */
export function createApiRouter(
  db: Database,
  events: EventManager,
  proxy: ProxyControl,
  ca?: CertificateAuthority,
  throttler?: Throttler,
): Router {
  const router = Router();

  const emitStatusEvent = () => {
    events.emitStatus({
      running: proxy.getProxyRunning(),
      proxyPort: proxy.getProxyPort(),
    });
  };

  router.get('/requests', (req: Request, res: Response) => {
    const filter: RequestFilter = {};
    if (req.query.host) filter.host = req.query.host as string;
    if (req.query.kind !== undefined) {
      // Rejected, not ignored: unlike the free-text/numeric filters below,
      // `kind` is a closed set, so a typo here is knowable rather than a silent no-op.
      if (req.query.kind !== 'http' && req.query.kind !== 'websocket') {
        res.status(400).json({ error: 'kind must be "http" or "websocket"' });
        return;
      }
      filter.kind = req.query.kind;
    }
    if (req.query.client_protocol !== undefined) {
      if (req.query.client_protocol !== 'http/1.1' && req.query.client_protocol !== 'h2') {
        res.status(400).json({ error: 'client_protocol must be "http/1.1" or "h2"' });
        return;
      }
      filter.clientProtocol = req.query.client_protocol;
    }
    if (req.query.origin_protocol !== undefined) {
      if (req.query.origin_protocol !== 'http/1.1' && req.query.origin_protocol !== 'h2') {
        res.status(400).json({ error: 'origin_protocol must be "http/1.1" or "h2"' });
        return;
      }
      filter.originProtocol = req.query.origin_protocol;
    }
    if (req.query.status) filter.status = parseInt(req.query.status as string, 10);
    if (req.query.method) filter.method = req.query.method as string;
    if (req.query.content_type) filter.content_type = req.query.content_type as string;
    if (req.query.search) filter.search = req.query.search as string;
    if (req.query.since) filter.since = parseInt(req.query.since as string, 10);
    if (req.query.until) filter.until = parseInt(req.query.until as string, 10);
    if (req.query.limit) filter.limit = parseInt(req.query.limit as string, 10);
    if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10);

    const result = db.query(filter);
    res.json({
      ...result,
      data: result.data.map(serializeRecord),
    });
  });

  router.get('/requests/:id', (req: Request, res: Response) => {
    const record = db.getById(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(serializeRecord(record));
  });

  router.get('/requests/:id/messages', (req: Request, res: Response) => {
    // Validate before hitting SQL: `parseInt('abc')` is NaN, which reaches
    // `LIMIT @limit` as an invalid bind and surfaces as an opaque 500.
    const limit = parsePositiveInt(req.query.limit, 500);
    const offset = parsePositiveInt(req.query.offset, 0);
    if (limit === null || offset === null) {
      res.status(400).json({ error: 'limit and offset must be non-negative integers' });
      return;
    }
    // Unknown ids return an empty page, not a 404, matching how `/requests`
    // treats filters with no matches — and skips an otherwise-unneeded db.getById lookup.
    const result = db.getWebSocketMessages(req.params.id as string, limit, offset);
    res.json({ ...result, data: result.data.map(serializeWsMessage) });
  });

  router.delete('/requests', (_req: Request, res: Response) => {
    db.deleteAll();
    res.json({ ok: true });
  });

  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      running: proxy.getProxyRunning(),
      proxyPort: proxy.getProxyPort(),
      requestCount: db.getRequestCount(),
      dbSizeBytes: db.getDbSize(),
      hostname: os.hostname(),
    });
  });

  router.get('/ca.crt', (_req: Request, res: Response) => {
    if (!ca) {
      res.status(404).json({ error: 'CA not available' });
      return;
    }
    const certPath = ca.getCaCertPath();
    if (!fs.existsSync(certPath)) {
      res.status(404).json({ error: 'CA certificate not found. Start the proxy first to generate it.' });
      return;
    }
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="laurel-proxy-ca.crt"');
    fs.createReadStream(certPath).pipe(res);
  });

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

    const body = req.body as ThrottlePutBody;
    let candidate: ThrottleSettingsInput;

    if (body.preset != null) {
      // A preset takes precedence over any explicit rate fields present in
      // the same body — it fully replaces the settings rather than merging.
      if (body.preset === 'off') {
        candidate = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 };
      } else {
        const preset = typeof body.preset === 'string' ? THROTTLE_PRESETS[body.preset] : undefined;
        if (!preset) {
          res.status(400).json({
            error: `Unknown preset "${String(body.preset)}". Available: ${Object.keys(THROTTLE_PRESETS).join(', ')}, off`,
          });
          return;
        }
        candidate = { enabled: true, ...preset };
      }
    } else {
      candidate = body;
    }

    // Shared with the config-file loader: a preset can't fail this, but routing
    // it through anyway keeps one point where settings become trusted.
    const validated = validateThrottleSettings(candidate, throttler.getSettings());
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const settings: ThrottleSettings = validated.settings;

    // Persist before applying to the live throttler: update() can't fail, so
    // this ordering is the only one that can't leave disk and memory disagreeing.
    try {
      saveThrottleSettings(settings);
    } catch (err) {
      res.status(500).json({
        error: `Failed to persist throttle settings, change was not applied: ${(err as Error).message}`,
      });
      return;
    }
    throttler.update(settings);
    res.json({ settings });
  });

  router.post('/proxy/start', async (_req: Request, res: Response) => {
    try {
      await proxy.startProxy();
      emitStatusEvent();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/proxy/stop', async (_req: Request, res: Response) => {
    try {
      await proxy.stopProxy();
      emitStatusEvent();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/system-proxy', async (_req: Request, res: Response) => {
    const enabled = await checkSystemProxyStatus();
    res.json({ enabled });
  });

  router.post('/system-proxy/enable', async (_req: Request, res: Response) => {
    const result = await enableSystemProxy(String(proxy.getProxyPort()));
    res.json(result);
  });

  router.post('/system-proxy/disable', async (_req: Request, res: Response) => {
    const result = await disableSystemProxy();
    res.json(result);
  });

  router.post('/replay', async (req: Request, res: Response) => {
    const { url, method, headers, body } = req.body as ReplayRequest;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      res.status(400).json({ error: 'Invalid or missing URL (must start with http:// or https://)' });
      return;
    }
    if (!method) {
      res.status(400).json({ error: 'Missing HTTP method' });
      return;
    }
    try {
      const result = await replay({ url, method, headers: headers || {}, body });
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('timed out')) {
        res.status(504).json({ error: message });
      } else {
        res.status(502).json({ error: message });
      }
    }
  });

  router.post('/websocket/replay', async (req: Request, res: Response) => {
    const body = req.body as Partial<WsReplayRequest> & { requestId?: string };

    if (body.timeoutMs !== undefined
      && (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0)) {
      res.status(400).json({ error: 'timeoutMs must be a positive number' });
      return;
    }

    // Type-checked, not just truthy: a non-string id reaches better-sqlite3
    // unbindable, and a non-string url reaches startsWith as a TypeError.
    let replayRequest: WsReplayRequest;
    if (typeof body.requestId === 'string' && body.requestId) {
      const record = db.getById(body.requestId);
      if (!record) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (record.kind !== 'websocket') {
        res.status(400).json({ error: 'Request is not a WebSocket connection' });
        return;
      }
      const messages = db.getWebSocketMessages(body.requestId, MAX_REPLAY_FRAMES, 0);
      // Refused rather than replayed in part, since a partial resend would look like
      // a completed replay. The frame count is both directions, so this is conservative.
      if (messages.total > messages.data.length) {
        res.status(400).json({
          error: `Connection has ${messages.total} recorded frames; replay handles at most ${MAX_REPLAY_FRAMES}`,
        });
        return;
      }
      // A frame truncated at maxBodySize is a corrupted prefix (mid-codepoint
      // text, broken JSON). Only client frames matter — a clipped server reply is fine.
      const truncated = messages.data.filter((m) => isReplayableFrame(m) && m.truncated !== 0);
      if (truncated.length > 0) {
        res.status(400).json({
          error: `Connection has ${truncated.length} truncated client frame(s) recorded; replay would send corrupted payloads`,
        });
        return;
      }
      replayRequest = { ...recordToWsReplayRequest(record, messages.data), timeoutMs: body.timeoutMs };
    } else if (typeof body.url === 'string' && body.url) {
      const parsed = parseWsReplayFrames(body.frames);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      replayRequest = { url: body.url, frames: parsed.frames, timeoutMs: body.timeoutMs };
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

  // Shutdown the entire server process
  router.post('/shutdown', (_req: Request, res: Response) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 100);
  });

  router.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const unsubRequest = events.subscribe((records) => {
      for (const record of records) {
        res.write(`event: request\nid: ${record.id}\ndata: ${JSON.stringify(serializeRecord(record))}\n\n`);
      }
    });

    const unsubStatus = events.subscribeStatus((status) => {
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    });

    const unsubWs = events.subscribeWsMessages((messages) => {
      for (const message of messages) {
        res.write(`event: ws-message\nid: ${message.id}\ndata: ${JSON.stringify(serializeWsMessage(message))}\n\n`);
      }
    });

    req.on('close', () => {
      unsubRequest();
      unsubStatus();
      unsubWs();
    });
  });

  return router;
}
