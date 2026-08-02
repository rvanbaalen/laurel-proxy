import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './db.js';
import { randomUUID } from 'node:crypto';
import type { RequestRecord } from '../shared/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import BetterSqlite3 from 'better-sqlite3';

function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://example.com/test',
    host: 'example.com',
    path: '/test',
    protocol: 'http',
    request_headers: '{"host":"example.com"}',
    request_body: null,
    request_size: 0,
    status: 200,
    response_headers: '{"content-type":"text/html"}',
    response_body: Buffer.from('hello'),
    response_size: 5,
    duration: 100,
    content_type: 'text/html',
    truncated: 0,
    ...overrides,
  };
}

// Alias kept for parity with the storage-layer vocabulary used elsewhere
// (a "base record" is a complete, valid RequestRecord ready to be overridden).
const baseRecord = makeRequest;

describe('Database', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `laurel-proxy-test-${randomUUID()}.db`);
    db = new Database(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('inserts and retrieves a request', () => {
    const req = makeRequest();
    db.insert(req);
    const result = db.getById(req.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(req.id);
    expect(result!.host).toBe('example.com');
    expect(result!.status).toBe(200);
  });

  it('queries with host filter', () => {
    db.insert(makeRequest({ host: 'api.example.com' }));
    db.insert(makeRequest({ host: 'cdn.other.com' }));
    const result = db.query({ host: 'example' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].host).toBe('api.example.com');
    expect(result.total).toBe(1);
  });

  it('queries with status filter', () => {
    db.insert(makeRequest({ status: 200 }));
    db.insert(makeRequest({ status: 500 }));
    const result = db.query({ status: 500 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe(500);
  });

  it('queries with method filter', () => {
    db.insert(makeRequest({ method: 'GET' }));
    db.insert(makeRequest({ method: 'POST' }));
    const result = db.query({ method: 'POST' });
    expect(result.data).toHaveLength(1);
  });

  it('queries with search filter on URL', () => {
    db.insert(makeRequest({ url: 'http://example.com/api/v2/users' }));
    db.insert(makeRequest({ url: 'http://example.com/index.html' }));
    const result = db.query({ search: '/api/v2' });
    expect(result.data).toHaveLength(1);
  });

  it('queries with time range', () => {
    const now = Date.now();
    db.insert(makeRequest({ timestamp: now - 10000 }));
    db.insert(makeRequest({ timestamp: now }));
    const result = db.query({ since: now - 5000 });
    expect(result.data).toHaveLength(1);
  });

  it('paginates results', () => {
    for (let i = 0; i < 5; i++) {
      db.insert(makeRequest({ timestamp: Date.now() + i }));
    }
    const page1 = db.query({ limit: 2, offset: 0 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
  });

  it('queries with a kind filter', () => {
    db.insert(makeRequest({ host: 'plain.example.com' }));
    db.insert(makeRequest({ host: 'socket.example.com', kind: 'websocket' }));

    const ws = db.query({ kind: 'websocket' });
    expect(ws.total).toBe(1);
    expect(ws.data[0].host).toBe('socket.example.com');

    const http = db.query({ kind: 'http' });
    expect(http.total).toBe(1);
    expect(http.data[0].host).toBe('plain.example.com');
  });

  it('counts a row with a NULL kind as http rather than dropping it from both filters', () => {
    // `kind` is a column added by migration with a DEFAULT, so existing rows read
    // back as 'http' — but the column is nullable, and a row written by anything
    // that bypasses `bindRecord` can hold NULL. `kind = 'http'` would silently
    // exclude it from both filters, which is worse than either answer: the row
    // would exist in an unfiltered list and vanish from every filtered one.
    const raw = new BetterSqlite3(dbPath);
    raw.prepare(
      `INSERT INTO requests (id, timestamp, method, url, host, path, protocol, kind)
       VALUES ('null-kind', 1, 'GET', 'http://n/x', 'n', '/x', 'http', NULL)`,
    ).run();
    raw.close();

    expect(db.query({ kind: 'http' }).data.map((r) => r.id)).toContain('null-kind');
    expect(db.query({ kind: 'websocket' }).data.map((r) => r.id)).not.toContain('null-kind');
  });

  it('deletes all requests', () => {
    db.insert(makeRequest());
    db.insert(makeRequest());
    db.deleteAll();
    const result = db.query({});
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns request count and db size', () => {
    db.insert(makeRequest());
    expect(db.getRequestCount()).toBe(1);
    expect(db.getDbSize()).toBeGreaterThan(0);
  });

  it('batch inserts multiple requests', () => {
    const requests = [makeRequest(), makeRequest(), makeRequest()];
    db.insertBatch(requests);
    expect(db.getRequestCount()).toBe(3);
  });

  it('queries with statusMin filter', () => {
    db.insert(makeRequest({ status: 200 }));
    db.insert(makeRequest({ status: 404 }));
    db.insert(makeRequest({ status: 500 }));
    const result = db.query({ statusMin: 400 });
    expect(result.data).toHaveLength(2);
    expect(result.data.map((r) => r.status).sort()).toEqual([404, 500]);
  });

  it('queries with statusMax filter', () => {
    db.insert(makeRequest({ status: 200 }));
    db.insert(makeRequest({ status: 404 }));
    db.insert(makeRequest({ status: 500 }));
    const result = db.query({ statusMax: 399 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe(200);
  });

  it('queries with statusMin + statusMax range', () => {
    db.insert(makeRequest({ status: 200 }));
    db.insert(makeRequest({ status: 404 }));
    db.insert(makeRequest({ status: 500 }));
    const result = db.query({ statusMin: 400, statusMax: 499 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe(404);
  });

  it('queries with durationMin filter', () => {
    db.insert(makeRequest({ duration: 50 }));
    db.insert(makeRequest({ duration: 200 }));
    db.insert(makeRequest({ duration: 1000 }));
    const result = db.query({ durationMin: 500 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].duration).toBe(1000);
  });

  it('combines statusMin with host filter', () => {
    db.insert(makeRequest({ status: 200, host: 'api.com' }));
    db.insert(makeRequest({ status: 500, host: 'api.com' }));
    db.insert(makeRequest({ status: 500, host: 'cdn.com' }));
    const result = db.query({ statusMin: 400, host: 'api' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe(500);
    expect(result.data[0].host).toBe('api.com');
  });

  it('stores and retrieves websocket messages in timestamp order', () => {
    db.insert({ ...baseRecord(), id: 'conn-1', kind: 'websocket', status: 101 });
    db.insertWebSocketMessages([
      { id: 'm2', request_id: 'conn-1', timestamp: 2000, direction: 'received',
        opcode: 'text', payload: Buffer.from('pong'), size: 4, truncated: 0 },
      { id: 'm1', request_id: 'conn-1', timestamp: 1000, direction: 'sent',
        opcode: 'text', payload: Buffer.from('ping'), size: 4, truncated: 0 },
    ]);

    const result = db.getWebSocketMessages('conn-1');
    expect(result.total).toBe(2);
    expect(result.data.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(result.data[0].direction).toBe('sent');
    expect(Buffer.from(result.data[0].payload!).toString()).toBe('ping');
  });

  it('scopes messages to their connection', () => {
    db.insert({ ...baseRecord(), id: 'conn-a', kind: 'websocket' });
    db.insert({ ...baseRecord(), id: 'conn-b', kind: 'websocket' });
    db.insertWebSocketMessages([
      { id: 'x', request_id: 'conn-a', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
    ]);
    expect(db.getWebSocketMessages('conn-b').total).toBe(0);
  });

  it('paginates messages', () => {
    db.insert({ ...baseRecord(), id: 'conn-p', kind: 'websocket' });
    db.insertWebSocketMessages(
      Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`, request_id: 'conn-p', timestamp: i, direction: 'sent' as const,
        opcode: 'text' as const, payload: Buffer.from(String(i)), size: 1, truncated: 0,
      })),
    );
    const page = db.getWebSocketMessages('conn-p', 2, 2);
    expect(page.total).toBe(5);
    expect(page.data.map((m) => m.id)).toEqual(['p2', 'p3']);
  });

  it('paginates without duplicating or skipping rows when messages share a timestamp', () => {
    // Frames within a single connection can be recorded within the same
    // millisecond, so `ORDER BY timestamp ASC` alone leaves ties formally
    // undefined per SQLite's docs. This guards the pagination math (limit/
    // offset) doesn't duplicate or drop rows across two calls.
    db.insert({ ...baseRecord(), id: 'conn-tie', kind: 'websocket' });
    db.insertWebSocketMessages(
      Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`, request_id: 'conn-tie', timestamp: 1000, direction: 'sent' as const,
        opcode: 'text' as const, payload: Buffer.from(String(i)), size: 1, truncated: 0,
      })),
    );

    const page1 = db.getWebSocketMessages('conn-tie', 3, 0);
    const page2 = db.getWebSocketMessages('conn-tie', 3, 3);
    const seen = [...page1.data, ...page2.data].map((m) => m.id);
    expect(new Set(seen).size).toBe(6); // no duplicates and no gaps across the two pages
    expect(seen).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']); // stable, insertion-order tiebreak
  });

  it('defaults kind to http for records that omit it', () => {
    db.insert({ ...baseRecord(), id: 'plain' });
    expect((db.getById('plain') as { kind?: string }).kind).toBe('http');
  });

  it('migrates a database created without the kind column', () => {
    const legacyPath = path.join(os.tmpdir(), `laurel-proxy-legacy-${randomUUID()}.db`);
    try {
      const legacy = new BetterSqlite3(legacyPath);
      legacy.exec(`
        CREATE TABLE requests (
          id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, method TEXT NOT NULL,
          url TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, protocol TEXT NOT NULL,
          request_headers TEXT, request_body BLOB, request_size INTEGER, status INTEGER,
          response_headers TEXT, response_body BLOB, response_size INTEGER,
          duration INTEGER, content_type TEXT, truncated INTEGER DEFAULT 0
        );
      `);
      legacy.prepare(
        `INSERT INTO requests (id, timestamp, method, url, host, path, protocol)
         VALUES ('old', 1, 'GET', 'http://x/', 'x', '/', 'http')`,
      ).run();
      legacy.close();

      const migrated = new Database(legacyPath);
      try {
        expect((migrated.getById('old') as { kind?: string }).kind).toBe('http');
        migrated.insert({ ...baseRecord(), id: 'new', kind: 'websocket' });
        expect((migrated.getById('new') as { kind?: string }).kind).toBe('websocket');
      } finally {
        migrated.close();
      }

      // The migration guard must be a no-op on a database that already has
      // `kind` — the constructor runs on every CLI invocation, so re-opening
      // an already-migrated database must never throw (e.g. from a duplicate
      // `ALTER TABLE ADD COLUMN`).
      const reopened = new Database(legacyPath);
      try {
        expect((reopened.getById('old') as { kind?: string }).kind).toBe('http');
        expect((reopened.getById('new') as { kind?: string }).kind).toBe('websocket');
      } finally {
        reopened.close();
      }
    } finally {
      try { fs.unlinkSync(legacyPath); } catch {}
      try { fs.unlinkSync(legacyPath + '-wal'); } catch {}
      try { fs.unlinkSync(legacyPath + '-shm'); } catch {}
    }
  });

  it('deletes orphaned websocket messages when their connection ages out', () => {
    const now = Date.now();
    db.insert({ ...baseRecord(), id: 'old-conn', kind: 'websocket', timestamp: now - 10000 });
    db.insert({ ...baseRecord(), id: 'new-conn', kind: 'websocket', timestamp: now });
    db.insertWebSocketMessages([
      { id: 'old-msg', request_id: 'old-conn', timestamp: now - 10000, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
      { id: 'new-msg', request_id: 'new-conn', timestamp: now, direction: 'sent',
        opcode: 'text', payload: Buffer.from('b'), size: 1, truncated: 0 },
    ]);

    db.deleteOlderThan(now - 5000);

    expect(db.getWebSocketMessages('old-conn').total).toBe(0);
    expect(db.getWebSocketMessages('new-conn').total).toBe(1);
  });

  it('deletes orphaned websocket messages when their connection is evicted by deleteOldest', () => {
    db.insert({ ...baseRecord(), id: 'evict-conn', kind: 'websocket', timestamp: 1 });
    db.insert({ ...baseRecord(), id: 'keep-conn', kind: 'websocket', timestamp: 2 });
    db.insertWebSocketMessages([
      { id: 'evict-msg', request_id: 'evict-conn', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
      { id: 'keep-msg', request_id: 'keep-conn', timestamp: 2, direction: 'sent',
        opcode: 'text', payload: Buffer.from('b'), size: 1, truncated: 0 },
    ]);

    const deleted = db.deleteOldest(1);

    expect(deleted).toBe(1);
    expect(db.getWebSocketMessages('evict-conn').total).toBe(0);
    expect(db.getWebSocketMessages('keep-conn').total).toBe(1);
  });

  it('sweeps websocket messages whose connection row never landed', () => {
    // Exactly the state the write flush can leave behind: the frame insert
    // succeeded on a tick whose request insert was dropped, so 'lost-conn' has
    // frames but no row. Nothing else can reclaim these — no foreign key rejects
    // them, no reader can see them, and both retention deletes select from
    // `requests`, so `deleteOldest` reports 0 and leaves them forever.
    db.insert({ ...baseRecord(), id: 'landed-conn', kind: 'websocket' });
    db.insertWebSocketMessages([
      { id: 'orphan-1', request_id: 'lost-conn', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
      { id: 'orphan-2', request_id: 'lost-conn', timestamp: 2, direction: 'received',
        opcode: 'text', payload: Buffer.from('b'), size: 1, truncated: 0 },
      { id: 'kept', request_id: 'landed-conn', timestamp: 3, direction: 'sent',
        opcode: 'text', payload: Buffer.from('c'), size: 1, truncated: 0 },
    ]);

    // Retention on its own cannot see the leak, which is why the sweep exists.
    expect(db.deleteOldest(100)).toBe(1);
    expect(db.getWebSocketMessages('lost-conn').total).toBe(2);

    expect(db.deleteOrphanedWebSocketMessages()).toBe(2);
    expect(db.getWebSocketMessages('lost-conn').total).toBe(0);
    // Idempotent: a second pass finds nothing left to reclaim.
    expect(db.deleteOrphanedWebSocketMessages()).toBe(0);
  });

  it('keeps frames whose connection row exists when sweeping orphans', () => {
    db.insert({ ...baseRecord(), id: 'live-conn', kind: 'websocket' });
    db.insertWebSocketMessages([
      { id: 'live-msg', request_id: 'live-conn', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
    ]);

    expect(db.deleteOrphanedWebSocketMessages()).toBe(0);
    expect(db.getWebSocketMessages('live-conn').total).toBe(1);
  });

  it('sweeps orphans even when a request row has a NULL id', () => {
    // SQLite allows NULL in a non-INTEGER PRIMARY KEY column, so `requests` can
    // hold a NULL id. A `NOT IN (SELECT id FROM requests)` sweep would evaluate
    // to NULL for every row and reclaim nothing at all; `NOT EXISTS` is immune.
    const raw = new BetterSqlite3(dbPath);
    try {
      raw.prepare(
        `INSERT INTO requests (id, timestamp, method, url, host, path, protocol)
         VALUES (NULL, 1, 'GET', 'http://x/', 'x', '/', 'http')`,
      ).run();
    } finally {
      raw.close();
    }
    db.insertWebSocketMessages([
      { id: 'orphan-null', request_id: 'gone-conn', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
    ]);

    expect(db.deleteOrphanedWebSocketMessages()).toBe(1);
  });

  it('deletes all websocket messages on deleteAll', () => {
    db.insert({ ...baseRecord(), id: 'conn-wipe', kind: 'websocket' });
    db.insertWebSocketMessages([
      { id: 'wipe-msg', request_id: 'conn-wipe', timestamp: 1, direction: 'sent',
        opcode: 'text', payload: Buffer.from('a'), size: 1, truncated: 0 },
    ]);
    db.deleteAll();
    expect(db.getWebSocketMessages('conn-wipe').total).toBe(0);
  });
});
