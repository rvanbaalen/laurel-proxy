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

function serializeRecord(r: RequestRecord): Record<string, unknown> {
  return {
    ...r,
    request_body: r.request_body ? Buffer.from(r.request_body).toString('base64') : null,
    response_body: r.response_body ? Buffer.from(r.response_body).toString('base64') : null,
  };
}

/**
 * `m.payload` is truthy for both a populated and a zero-length Buffer (it's
 * an object either way), so an empty payload correctly base64-encodes to ''
 * and only a genuinely absent (null) payload stays null.
 */
function serializeWsMessage(m: WebSocketMessage): Record<string, unknown> {
  return {
    ...m,
    payload: m.payload ? Buffer.from(m.payload).toString('base64') : null,
  };
}

/**
 * Returns the parsed value, the fallback when the param is absent, or null
 * when present but not a non-negative integer. `0` is a deliberately valid
 * value distinct from "absent" — `?limit=0` means "give me zero rows" (still
 * reporting the true `total`), the same way `?offset=0` already means "start
 * at the beginning" rather than falling back to a default.
 */
function parsePositiveInt(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Frames a single replay will send, from either request form. */
const MAX_REPLAY_FRAMES = 10_000;

/**
 * Standard base64 — correct alphabet, correct length, correct padding.
 * `Buffer.from(s, 'base64')` silently discards anything it doesn't recognise,
 * so without this a payload like `"hello world!"` decodes to arbitrary bytes and
 * gets replayed as garbage.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Validates and normalises client-supplied replay frames, returning either the
 * frames or the reason they were refused.
 *
 * Everything checkable is checked here rather than left to fail mid-send: a
 * missing opcode, a payload that is not really base64, or a frame list long
 * enough to tie up the process would otherwise come back as a 200 whose `error`
 * field blames the connection for a client mistake.
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

export interface ProxyControl {
  getProxyRunning: () => boolean;
  getProxyPort: () => number;
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;
}

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
      // Rejected rather than ignored: a caller that asked for one kind and
      // silently received every kind has been given a wrong answer with nothing
      // to indicate it. Every other filter here is a free-text or numeric match
      // where a typo narrows the result; `kind` is a closed set, so a typo is
      // knowable.
      if (req.query.kind !== 'http' && req.query.kind !== 'websocket') {
        res.status(400).json({ error: 'kind must be "http" or "websocket"' });
        return;
      }
      filter.kind = req.query.kind;
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
    // An unknown request id is treated the same as a known id with zero
    // messages — an empty page, not a 404 — mirroring the plain `/requests`
    // list endpoint, whose filters that match nothing also return `total: 0`
    // rather than an error. Since a websocket connection with no captured
    // frames yet is indistinguishable from a nonexistent id without an extra
    // db.getById lookup this endpoint has no other reason to make, treating
    // them alike keeps this a pure collection read.
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

    // One validator, shared with the config-file loader. A preset is a
    // compile-time constant and cannot fail this, but routing it through anyway
    // keeps a single point where settings become trusted.
    const validated = validateThrottleSettings(candidate, throttler.getSettings());
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const settings: ThrottleSettings = validated.settings;

    // Nothing above mutates live state: a rejected request must leave both
    // the running throttler and the persisted config untouched. Persist
    // first, then apply to the live throttler only once the write has
    // actually succeeded — the config file is the durable record, and an
    // in-memory update() can't fail, so this ordering is the only one that
    // can't leave disk and memory disagreeing. A restart after a failed
    // write must not silently revert the settings the caller just saw
    // applied; failing the request loudly is better than that.
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

    // Both discriminators are type-checked, not just truthiness: a non-string
    // id would reach better-sqlite3 as an unbindable value, and a non-string
    // url would reach replayWebSocket's startsWith as a TypeError.
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
      // Refused rather than replayed in part: silently resending a prefix of a
      // conversation would look like a completed replay. The count is of every
      // recorded frame, both directions, so this is conservative — a refused
      // connection might still have had few enough client frames to fit.
      if (messages.total > messages.data.length) {
        res.status(400).json({
          error: `Connection has ${messages.total} recorded frames; replay handles at most ${MAX_REPLAY_FRAMES}`,
        });
        return;
      }
      // A frame clipped at maxBodySize was recorded as a prefix of what the
      // client really sent, with `truncated: 1` to say so. Resending that prefix
      // delivers a corrupted message — truncated JSON, or text cut mid-codepoint
      // — while the response would claim success, so refuse instead. Only the
      // frames this replay would send matter: a clipped *server* reply says
      // nothing about the fidelity of what we are about to send.
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
