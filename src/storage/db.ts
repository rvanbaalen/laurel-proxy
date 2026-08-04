import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  RequestRecord,
  RequestFilter,
  PaginatedResponse,
  WebSocketMessage,
} from '../shared/types.js';
import fs from 'node:fs';

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');

    // auto_vacuum can only be set on a fresh DB; convert existing ones with a one-time VACUUM
    const currentMode = (
      this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }
    ).auto_vacuum;
    if (currentMode !== 2) {
      this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      this.db.exec('VACUUM');
    }

    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        host TEXT NOT NULL,
        path TEXT NOT NULL,
        protocol TEXT NOT NULL,
        request_headers TEXT,
        request_body BLOB,
        request_size INTEGER,
        status INTEGER,
        response_headers TEXT,
        response_body BLOB,
        response_size INTEGER,
        duration INTEGER,
        content_type TEXT,
        truncated INTEGER DEFAULT 0,
        kind TEXT DEFAULT 'http',
        client_protocol TEXT,
        origin_protocol TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp);
      CREATE INDEX IF NOT EXISTS idx_host ON requests(host);
      CREATE INDEX IF NOT EXISTS idx_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_path ON requests(path);
      CREATE INDEX IF NOT EXISTS idx_content_type ON requests(content_type);
      CREATE INDEX IF NOT EXISTS idx_duration ON requests(duration);
      CREATE TABLE IF NOT EXISTS websocket_messages (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        opcode TEXT NOT NULL,
        payload BLOB,
        size INTEGER NOT NULL,
        truncated INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ws_request_id ON websocket_messages(request_id);
      CREATE INDEX IF NOT EXISTS idx_ws_timestamp ON websocket_messages(timestamp);
    `);
    this.migrate();
  }

  /**
   * Adds columns introduced after the original schema shipped, guarded by
   * `table_info` so each is a no-op past its first run — this fires on
   * construction, so it must not throw against an up-to-date db.
   */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'kind')) {
      this.db.exec(`ALTER TABLE requests ADD COLUMN kind TEXT DEFAULT 'http'`);
    }
    // Rows predating HTTP/2 really were http/1.1 on both hops, so backfilling
    // that literal isn't a guess (contrast the null default in `bindRecord`).
    if (!columns.some((c) => c.name === 'client_protocol')) {
      this.db.exec(`ALTER TABLE requests ADD COLUMN client_protocol TEXT DEFAULT 'http/1.1'`);
    }
    if (!columns.some((c) => c.name === 'origin_protocol')) {
      this.db.exec(`ALTER TABLE requests ADD COLUMN origin_protocol TEXT DEFAULT 'http/1.1'`);
    }
  }

  /**
   * Normalizes optional fields before binding so named-parameter statements
   * never see a missing key.
   *
   * `client_protocol`/`origin_protocol` default to `null`, not `'http/1.1'`:
   * unlike `kind`, whose pre-feature history really was uniformly `'http'`
   * (see `migrate`), a *newly constructed* record that omits a wire protocol
   * has no such guarantee behind it — every current call site sets both
   * explicitly, so a caller that didn't is exactly the "unknown reported as a
   * definite value" failure this project singles out. Storing `null` keeps
   * that failure visible instead of papering over it with a plausible-looking
   * default.
   */
  private bindRecord(record: RequestRecord): Record<string, SQLInputValue> {
    return {
      ...record,
      kind: record.kind ?? 'http',
      client_protocol: record.client_protocol ?? null,
      origin_protocol: record.origin_protocol ?? null,
    };
  }

  /**
   * node:sqlite has no `better-sqlite3`-style `.transaction()` wrapper, so
   * batched writes roll their own BEGIN/COMMIT/ROLLBACK.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * node:sqlite reads BLOB columns back as `Uint8Array`, not `Buffer` here
   * so every downstream consumer converts once at the boundary instead
   * of repeating it at each call site.
   */
  private static toBuffer(value: unknown): Buffer | null {
    return value == null ? null : Buffer.from(value as Uint8Array);
  }

  insert(record: RequestRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO requests (
        id, timestamp, method, url, host, path, protocol,
        request_headers, request_body, request_size,
        status, response_headers, response_body, response_size,
        duration, content_type, truncated, kind, client_protocol, origin_protocol
      ) VALUES (
        @id, @timestamp, @method, @url, @host, @path, @protocol,
        @request_headers, @request_body, @request_size,
        @status, @response_headers, @response_body, @response_size,
        @duration, @content_type, @truncated, @kind, @client_protocol, @origin_protocol
      )
    `);
    stmt.run(this.bindRecord(record));
  }

  insertBatch(records: RequestRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO requests (
        id, timestamp, method, url, host, path, protocol,
        request_headers, request_body, request_size,
        status, response_headers, response_body, response_size,
        duration, content_type, truncated, kind, client_protocol, origin_protocol
      ) VALUES (
        @id, @timestamp, @method, @url, @host, @path, @protocol,
        @request_headers, @request_body, @request_size,
        @status, @response_headers, @response_body, @response_size,
        @duration, @content_type, @truncated, @kind, @client_protocol, @origin_protocol
      )
    `);
    this.transaction(() => {
      for (const record of records) {
        stmt.run(this.bindRecord(record));
      }
    });
  }

  insertWebSocketMessages(messages: WebSocketMessage[]): void {
    if (messages.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO websocket_messages (
        id, request_id, timestamp, direction, opcode, payload, size, truncated
      ) VALUES (
        @id, @request_id, @timestamp, @direction, @opcode, @payload, @size, @truncated
      )
    `);
    this.transaction(() => {
      for (const row of messages) stmt.run(row as unknown as Record<string, SQLInputValue>);
    });
  }

  getWebSocketMessages(
    requestId: string,
    limit = 500,
    offset = 0,
  ): PaginatedResponse<WebSocketMessage> {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM websocket_messages WHERE request_id = ?')
        .get(requestId) as { count: number }
    ).count;
    const data = this.db
      .prepare(
        // `rowid ASC` breaks ties on `timestamp`, whose order SQLite leaves
        // undefined, so paginated calls can't duplicate or skip a tied row.
        `SELECT * FROM websocket_messages WHERE request_id = @requestId
         ORDER BY timestamp ASC, rowid ASC LIMIT @limit OFFSET @offset`,
      )
      .all({ requestId, limit, offset }) as unknown as WebSocketMessage[];
    return {
      data: data.map((row) => ({ ...row, payload: Database.toBuffer(row.payload) })),
      total,
      limit,
      offset,
    };
  }

  getById(id: string): RequestRecord | null {
    const stmt = this.db.prepare('SELECT * FROM requests WHERE id = ?');
    const row = stmt.get(id) as RequestRecord | undefined;
    return row ? this.mapRequestRow(row) : null;
  }

  private mapRequestRow(row: RequestRecord): RequestRecord {
    return {
      ...row,
      request_body: Database.toBuffer(row.request_body),
      response_body: Database.toBuffer(row.response_body),
    };
  }

  query(filter: RequestFilter): PaginatedResponse<RequestRecord> {
    const conditions: string[] = [];
    const params: Record<string, SQLInputValue> = {};

    if (filter.host) {
      conditions.push('host LIKE @host');
      params.host = `%${filter.host}%`;
    }
    if (filter.kind) {
      // `kind` is a migrated column, so 'http' has to include NULL: see the note
      // on `RequestFilter.kind`.
      if (filter.kind === 'http') {
        // No bound parameter here on purpose: better-sqlite3 rejects a named
        // parameter the statement does not use.
        conditions.push("(kind IS NULL OR kind = 'http')");
      } else {
        conditions.push('kind = @kind');
        params.kind = filter.kind;
      }
    }
    if (filter.clientProtocol) {
      // Exact match, no NULL-inclusion special case: see the note on
      // `RequestFilter.clientProtocol`.
      conditions.push('client_protocol = @clientProtocol');
      params.clientProtocol = filter.clientProtocol;
    }
    if (filter.originProtocol) {
      conditions.push('origin_protocol = @originProtocol');
      params.originProtocol = filter.originProtocol;
    }
    if (filter.status !== undefined) {
      conditions.push('status = @status');
      params.status = filter.status;
    }
    if (filter.statusMin !== undefined) {
      conditions.push('status >= @statusMin');
      params.statusMin = filter.statusMin;
    }
    if (filter.statusMax !== undefined) {
      conditions.push('status <= @statusMax');
      params.statusMax = filter.statusMax;
    }
    if (filter.durationMin !== undefined) {
      conditions.push('duration > @durationMin');
      params.durationMin = filter.durationMin;
    }
    if (filter.method) {
      conditions.push('method = @method');
      params.method = filter.method.toUpperCase();
    }
    if (filter.content_type) {
      conditions.push('content_type LIKE @content_type');
      params.content_type = `%${filter.content_type}%`;
    }
    if (filter.search) {
      conditions.push('url LIKE @search');
      params.search = `%${filter.search}%`;
    }
    if (filter.since) {
      conditions.push('timestamp >= @since');
      params.since = filter.since;
    }
    if (filter.until) {
      conditions.push('timestamp <= @until');
      params.until = filter.until;
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM requests ${where}`);
    const total = (countStmt.get(params) as { count: number }).count;

    const dataStmt = this.db.prepare(
      `SELECT * FROM requests ${where} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`
    );
    const data = dataStmt.all({ ...params, limit, offset }) as unknown as RequestRecord[];

    return { data: data.map((row) => this.mapRequestRow(row)), total, limit, offset };
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM websocket_messages');
    this.db.exec('DELETE FROM requests');
    this.db.exec('VACUUM');
  }

  deleteOlderThan(timestampMs: number): number {
    // Must run before the requests delete below: its subquery reads
    // `requests` to find the connections being removed.
    this.db
      .prepare(
        `DELETE FROM websocket_messages WHERE request_id IN
         (SELECT id FROM requests WHERE timestamp < ?)`,
      )
      .run(timestampMs);
    return Number(
      this.db.prepare('DELETE FROM requests WHERE timestamp < ?').run(timestampMs).changes,
    );
  }

  deleteOldest(limit: number): number {
    // Captures the id set once and reuses it for both deletes, rather than
    // running the "oldest N" subquery twice and relying on identical results.
    const ids = (
      this.db.prepare('SELECT id FROM requests ORDER BY timestamp ASC LIMIT ?').all(limit) as {
        id: string;
      }[]
    ).map((r) => r.id);
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM websocket_messages WHERE request_id IN (${placeholders})`)
      .run(...ids);
    return Number(
      this.db.prepare(`DELETE FROM requests WHERE id IN (${placeholders})`).run(...ids).changes,
    );
  }

  /**
   * Deletes frames whose connection row is missing, and returns how many went.
   *
   * These can exist because the write flush guards its two inserts separately
   * and drops what it cannot write: one unwritable record fails the whole
   * `insertBatch` transaction — including a WebSocket connection row — while the
   * frame insert on the same tick succeeds. Nothing else would ever reclaim
   * them. `request_id` carries an index rather than a foreign key, so the
   * database does not reject them; every reader looks frames up by a
   * `requests.id` that no longer exists, so they are invisible; and both
   * retention deletes select from `requests`, so `deleteOldest` reports 0 and
   * gives up while the orphans remain. Left alone they are a permanent leak.
   *
   * `NOT EXISTS` rather than `NOT IN` on purpose: SQLite allows NULL in a
   * non-INTEGER `PRIMARY KEY` column, and a single NULL `requests.id` would make
   * a `NOT IN` predicate never true — the sweep would silently stop reclaiming
   * anything, which is the exact failure it exists to fix.
   */
  deleteOrphanedWebSocketMessages(): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM websocket_messages WHERE NOT EXISTS
           (SELECT 1 FROM requests WHERE requests.id = websocket_messages.request_id)`,
        )
        .run().changes,
    );
  }

  incrementalVacuum(): void {
    this.db.exec('PRAGMA incremental_vacuum');
  }

  getRequestCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM requests');
    return (stmt.get() as { count: number }).count;
  }

  getDbSize(): number {
    const pageCount = (this.db.prepare('PRAGMA page_count').get() as { page_count: number })
      .page_count;
    const pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number })
      .page_size;
    return pageCount * pageSize;
  }

  close(): void {
    this.db.close();
  }
}
