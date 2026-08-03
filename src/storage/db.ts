import BetterSqlite3 from 'better-sqlite3';
import type {
  RequestRecord,
  RequestFilter,
  PaginatedResponse,
  WebSocketMessage,
} from '../shared/types.js';
import fs from 'node:fs';

export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');

    // auto_vacuum can only be set on a fresh DB; convert existing ones with a one-time VACUUM
    const currentMode = this.db.pragma('auto_vacuum', { simple: true }) as number;
    if (currentMode !== 2) {
      this.db.pragma('auto_vacuum = INCREMENTAL');
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
   * Add columns introduced after the original schema shipped. Guarded by
   * `table_info` so it is a no-op on every run after the first — this runs on
   * every `Database` construction (i.e. every CLI invocation), so it must
   * never throw against a database that already has the column.
   */
  private migrate(): void {
    const columns = this.db.pragma('table_info(requests)') as { name: string }[];
    if (!columns.some((c) => c.name === 'kind')) {
      this.db.exec(`ALTER TABLE requests ADD COLUMN kind TEXT DEFAULT 'http'`);
    }
    // Both hops predate this pair of columns by construction: before HTTP/2
    // support existed, every exchange this proxy ever recorded spoke
    // HTTP/1.1 on both the client and origin hops, full stop. So — unlike a
    // brand-new record that omits these fields, which means genuinely unknown
    // (see `bindRecord`) — backfilling every pre-existing row with
    // `'http/1.1'` is not a guess, it's the only value that could ever have
    // been true for a row written before this column existed.
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
  private bindRecord(record: RequestRecord): Record<string, unknown> {
    return {
      ...record,
      kind: record.kind ?? 'http',
      client_protocol: record.client_protocol ?? null,
      origin_protocol: record.origin_protocol ?? null,
    };
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
    const insertMany = this.db.transaction((records: RequestRecord[]) => {
      for (const record of records) {
        stmt.run(this.bindRecord(record));
      }
    });
    insertMany(records);
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
    const insertMany = this.db.transaction((rows: WebSocketMessage[]) => {
      for (const row of rows) stmt.run(row);
    });
    insertMany(messages);
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
        // SQLite documents tie order under `ORDER BY timestamp` alone as
        // undefined, and frames within one connection can share a millisecond
        // timestamp. Adding `rowid ASC` (implicit, since the table isn't
        // WITHOUT ROWID) makes the order fully deterministic and matches
        // insertion order, so paginated calls can't duplicate or skip a tied
        // row even if a future schema/query-plan change altered the
        // otherwise-unspecified tie behavior.
        `SELECT * FROM websocket_messages WHERE request_id = @requestId
         ORDER BY timestamp ASC, rowid ASC LIMIT @limit OFFSET @offset`,
      )
      .all({ requestId, limit, offset }) as WebSocketMessage[];
    return { data, total, limit, offset };
  }

  getById(id: string): RequestRecord | null {
    const stmt = this.db.prepare('SELECT * FROM requests WHERE id = ?');
    return (stmt.get(id) as RequestRecord) ?? null;
  }

  query(filter: RequestFilter): PaginatedResponse<RequestRecord> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

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
    const data = dataStmt.all({ ...params, limit, offset }) as RequestRecord[];

    return { data, total, limit, offset };
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM websocket_messages');
    this.db.exec('DELETE FROM requests');
    this.db.exec('VACUUM');
  }

  deleteOlderThan(timestampMs: number): number {
    // Must run before the requests delete below: the subquery reads
    // `requests` to find which connections are being removed, so it needs
    // those rows to still exist. Deleting requests first would make this
    // match nothing and orphan every message for the deleted connections.
    this.db
      .prepare(
        `DELETE FROM websocket_messages WHERE request_id IN
         (SELECT id FROM requests WHERE timestamp < ?)`,
      )
      .run(timestampMs);
    return this.db.prepare('DELETE FROM requests WHERE timestamp < ?').run(timestampMs).changes;
  }

  deleteOldest(limit: number): number {
    // Capture the exact set of oldest ids once, up front, and reuse it for
    // both deletes. Running the "oldest N" subquery twice (once for the
    // message cleanup, once for the requests delete) would rely on the two
    // independent SELECTs returning identical rows for the child delete to
    // see the right set — true today since nothing mutates `requests`
    // between the two statements, but fragile to reason about and to keep
    // true under future changes. Capturing ids removes that assumption.
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
    return this.db.prepare(`DELETE FROM requests WHERE id IN (${placeholders})`).run(...ids)
      .changes;
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
    return this.db
      .prepare(
        `DELETE FROM websocket_messages WHERE NOT EXISTS
         (SELECT 1 FROM requests WHERE requests.id = websocket_messages.request_id)`,
      )
      .run().changes;
  }

  incrementalVacuum(): void {
    this.db.pragma('incremental_vacuum');
  }

  getRequestCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM requests');
    return (stmt.get() as { count: number }).count;
  }

  getDbSize(): number {
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    return pageCount * pageSize;
  }

  close(): void {
    this.db.close();
  }
}
