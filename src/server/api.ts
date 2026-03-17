import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Database } from '../storage/db.js';
import type { EventManager } from './events.js';
import type { RequestFilter } from '../shared/types.js';

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
): Router {
  const router = Router();

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
    res.json(result);
  });

  router.get('/requests/:id', (req: Request, res: Response) => {
    const record = db.getById(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(record);
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
    });
  });

  router.post('/proxy/start', async (_req: Request, res: Response) => {
    try {
      await proxy.startProxy();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/proxy/stop', async (_req: Request, res: Response) => {
    try {
      await proxy.stopProxy();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const unsubscribe = events.subscribe((records) => {
      for (const record of records) {
        res.write(`id: ${record.id}\n`);
        res.write(`data: ${JSON.stringify(record)}\n\n`);
      }
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  return router;
}
