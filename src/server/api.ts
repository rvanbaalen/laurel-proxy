import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import type { Database } from '../storage/db.js';
import type { EventManager } from './events.js';
import type { RequestFilter, RequestRecord } from '../shared/types.js';
import type { CertificateAuthority } from './ssl.js';
import type { ReplayRequest } from '../shared/types.js';
import { replay } from './replay.js';
import { enableSystemProxy, disableSystemProxy, checkSystemProxyStatus } from '../cli/system-proxy.js';
import type { Throttler } from './throttle.js';
import { THROTTLE_PRESETS } from './throttle.js';
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
    let settings: ThrottleSettings;

    if (body.preset != null) {
      // A preset takes precedence over any explicit rate fields present in
      // the same body — it fully replaces the settings rather than merging.
      if (body.preset === 'off') {
        settings = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 };
      } else {
        const preset = typeof body.preset === 'string' ? THROTTLE_PRESETS[body.preset] : undefined;
        if (!preset) {
          res.status(400).json({
            error: `Unknown preset "${String(body.preset)}". Available: ${Object.keys(THROTTLE_PRESETS).join(', ')}, off`,
          });
          return;
        }
        settings = { enabled: true, ...preset };
      }
    } else {
      const current = throttler.getSettings();
      const enabled = body.enabled ?? current.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      settings = {
        enabled,
        downKbps: (body.downKbps ?? current.downKbps) as number,
        upKbps: (body.upKbps ?? current.upKbps) as number,
        latencyMs: (body.latencyMs ?? current.latencyMs) as number,
      };
    }

    for (const key of ['downKbps', 'upKbps', 'latencyMs'] as const) {
      if (!Number.isFinite(settings[key]) || settings[key] < 0) {
        res.status(400).json({ error: `${key} must be a non-negative number` });
        return;
      }
    }

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

    req.on('close', () => {
      unsubRequest();
      unsubStatus();
    });
  });

  return router;
}
