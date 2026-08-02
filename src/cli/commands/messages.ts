import type { Command } from 'commander';
import http from 'node:http';
import { Database } from '../../storage/db.js';
import { loadConfig } from '../../server/config.js';
import { formatWsMessages, formatWsMessageLine } from '../format.js';
import type { WebSocketMessage } from '../../shared/types.js';

const VALID_FORMATS = ['json', 'table', 'agent'];

/**
 * Reports a failure respecting --format, matching the convention established
 * in commands/throttle.ts: plain text on stderr for humans, a JSON object on
 * stdout for --format json/agent, so a script or AI agent always gets
 * parseable output on a failure path, not just on success.
 */
function reportError(message: string, format: string): void {
  if (format === 'json' || format === 'agent') {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(message);
  }
}

/**
 * Stream ws-message SSE events for one connection. Exported so an
 * integration test can drive it against a real event stream, the same
 * reason commands/throttle.ts exports `api`.
 */
export function followMessages(port: number, requestId: string, format: string): void {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
    (res) => {
      if (res.statusCode !== 200) {
        reportError(`Failed to connect to event stream (status ${res.statusCode}). Is the proxy running?`, format);
        process.exit(1);
      }
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // Parse SSE events from the buffer. A `data:` line is a single-line
        // JSON.stringify()'d object, so it can never contain a literal
        // newline (JSON.stringify escapes control characters, including the
        // base64/utf8 payload string) — splitting on the blank-line
        // separator can't misfire on payload content. An event split across
        // two TCP chunks is handled by only consuming complete `\n\n`-
        // delimited parts and carrying the remainder into the next chunk.
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          let eventType = '';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (eventType !== 'ws-message' || !data) continue;
          try {
            // The server base64-encodes `payload` for every opcode
            // unconditionally (see serializeWsMessage in server/api.ts) —
            // decode back to a Buffer here so formatWsMessageLine can
            // re-derive the right text/base64 encoding per opcode, exactly
            // as it does for a message read straight from the database.
            const raw = JSON.parse(data) as WebSocketMessage & { payload: string | null };
            if (raw.request_id !== requestId) continue;
            console.log(
              formatWsMessageLine(
                { ...raw, payload: raw.payload ? Buffer.from(raw.payload, 'base64') : null },
                format,
              ),
            );
          } catch {
            // Ignore malformed events
          }
        }
      });
      res.on('end', () => {
        console.error('Event stream closed.');
        process.exit(0);
      });
    },
  );
  req.on('error', () => {
    reportError('Could not connect to proxy. Is it running?', format);
    process.exit(1);
  });
  req.end();
}

export function registerMessages(program: Command): void {
  program
    .command('messages <id>')
    .description('Show WebSocket frames captured for a connection')
    .option('--follow', 'Stream new frames as they arrive')
    .option('--limit <n>', 'Max frames to show', '500')
    .option('--format <format>', 'Output format (json|table|agent)', 'table')
    .option('--ui-port <number>', 'UI/API port for --follow', '8081')
    .option('--db-path <path>', 'Database path')
    .action((id: string, opts) => {
      if (!VALID_FORMATS.includes(opts.format)) {
        console.error(`Invalid format "${opts.format}". Valid formats: ${VALID_FORMATS.join(', ')}`);
        process.exit(1);
        return;
      }

      // Resolve the id (and confirm it names a WebSocket connection) via the
      // database up front, for both the non-follow and --follow paths. A
      // typo'd or non-WebSocket id would otherwise make --follow wait
      // silently forever on a stream that can never emit a matching event,
      // and a non-follow read against a plain HTTP request id would print
      // an uninformative "No messages captured" instead of explaining why.
      const config = loadConfig(opts.dbPath ? { dbPath: opts.dbPath } : {});
      const db = new Database(config.dbPath);
      const record = db.getById(id);

      if (!record) {
        db.close();
        reportError(`No request found with id ${id}`, opts.format);
        process.exit(1);
        return;
      }
      if ((record.kind ?? 'http') !== 'websocket') {
        db.close();
        reportError(
          `Request ${id} is a ${record.kind ?? 'http'} request, not a WebSocket connection. Use "laurel-proxy request ${id}" to view it instead.`,
          opts.format,
        );
        process.exit(1);
        return;
      }

      if (opts.follow) {
        db.close();
        followMessages(parseInt(opts.uiPort, 10), id, opts.format);
        return;
      }

      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        db.close();
        reportError(`Invalid --limit value "${opts.limit}": expected a non-negative integer.`, opts.format);
        process.exit(1);
        return;
      }

      const result = db.getWebSocketMessages(id, limit, 0);
      console.log(formatWsMessages(result, opts.format));
      db.close();
    });
}
