import type { Command } from 'commander';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../storage/db.js';
import { loadConfig } from '../../server/config.js';
import { RoxyProxyServer } from '../../server/index.js';
import { formatRequests, formatTailLine } from '../format.js';
import { enableSystemProxy, disableSystemProxy, checkSystemProxyStatus } from '../system-proxy.js';
import type { RequestFilter, RequestRecord } from '../../shared/types.js';

/** Try to reach the API; resolves true if proxy is reachable. */
function isProxyRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/status', method: 'GET', timeout: 1000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Start a proxy server, enable system proxy, return instance and ports. */
async function autoStartProxy(requestedUiPort: number): Promise<{ server: RoxyProxyServer; uiPort: number; systemProxyEnabled: boolean }> {
  const config = loadConfig({ uiPort: requestedUiPort });
  const pidPath = path.join(os.homedir(), '.roxyproxy', 'pid');
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, process.pid.toString());

  const server = new RoxyProxyServer(config);
  const ports = await server.start();

  // Enable system proxy so traffic flows through automatically
  let systemProxyEnabled = false;
  const alreadyEnabled = await checkSystemProxyStatus();
  if (!alreadyEnabled) {
    const proxyResult = await enableSystemProxy(String(ports.proxyPort));
    systemProxyEnabled = proxyResult.ok;
  }

  const shutdown = async () => {
    if (systemProxyEnabled) await disableSystemProxy();
    await server.stop();
    try { fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, uiPort: ports.uiPort, systemProxyEnabled };
}

/** Build a RequestFilter from CLI options. Shared by tail and query paths. */
export function buildFilter(opts: Record<string, string | boolean | undefined>): RequestFilter {
  const filter: RequestFilter = {};

  if (opts.host) filter.host = opts.host as string;
  if (opts.method) filter.method = opts.method as string;
  if (opts.search) filter.search = opts.search as string;
  if (opts.since) filter.since = parseTime(opts.since as string);
  if (opts.until) filter.until = parseTime(opts.until as string);
  if (opts.limit) filter.limit = parseInt(opts.limit as string, 10);

  // --status (exact) takes precedence over --failed (range)
  if (opts.status) {
    if (opts.failed) {
      console.error('Warning: --status and --failed both specified; using --status (exact match)');
    }
    filter.status = parseInt(opts.status as string, 10);
  } else if (opts.failed) {
    filter.statusMin = 400;
  }

  // Time-based aliases
  if (opts.lastHour) filter.since = Date.now() - 60 * 60 * 1000;
  if (opts.lastDay) filter.since = Date.now() - 24 * 60 * 60 * 1000;

  // Duration filter
  if (opts.slow) filter.durationMin = parseInt(opts.slow as string, 10);

  return filter;
}

export function registerRequests(program: Command): void {
  program
    .command('requests')
    .description('Query captured requests')
    .option('--host <pattern>', 'Filter by hostname')
    .option('--status <code>', 'Filter by status code')
    .option('--failed', 'Show only 4xx and 5xx responses')
    .option('--method <method>', 'Filter by HTTP method')
    .option('--search <pattern>', 'Search URL')
    .option('--since <time>', 'Requests after this time')
    .option('--until <time>', 'Requests before this time')
    .option('--last-hour', 'Requests from the last hour')
    .option('--last-day', 'Requests from the last 24 hours')
    .option('--slow <ms>', 'Requests slower than threshold (ms)')
    .option('--limit <n>', 'Max results', '100')
    .option('--format <format>', 'Output format (json|table|agent)')
    .option('--tail', 'Stream new requests in real-time')
    .option('--ui-port <number>', 'UI/API port for --tail', '8081')
    .option('--db-path <path>', 'Database path')
    .action(async (opts) => {
      // Validate format
      const validFormats = ['json', 'table', 'agent'];
      if (opts.format && !validFormats.includes(opts.format)) {
        console.error(`Invalid format "${opts.format}". Valid formats: ${validFormats.join(', ')}`);
        process.exit(1);
      }

      const filter = buildFilter(opts);

      if (opts.tail) {
        // Default to table (interactive TUI) when tailing
        const format = opts.format ?? 'table';
        let uiPort = parseInt(opts.uiPort, 10);
        let server: RoxyProxyServer | null = null;

        // Auto-start proxy if not running
        let didEnableSystemProxy = false;
        const running = await isProxyRunning(uiPort);
        if (!running) {
          try {
            const result = await autoStartProxy(uiPort);
            server = result.server;
            uiPort = result.uiPort;
            didEnableSystemProxy = result.systemProxyEnabled;
            console.error(`Proxy started (UI on :${uiPort})${didEnableSystemProxy ? ' — system proxy enabled' : ''}`);
          } catch (e) {
            console.error(`Failed to start proxy: ${(e as Error).message}`);
            process.exit(1);
          }
        }

        if (format === 'table') {
          // Launch interactive Ink TUI
          const { launchTailUi } = await import('../tail-ui.js');
          launchTailUi(uiPort, filter, server, didEnableSystemProxy);
          return;
        }

        // JSON/agent streaming mode (plain stdout)
        tailRequests(uiPort, filter, format);
        return;
      }

      const config = loadConfig(opts.dbPath ? { dbPath: opts.dbPath } : {});
      const db = new Database(config.dbPath);

      const result = db.query(filter);
      console.log(formatRequests(result, opts.format ?? 'table'));
      db.close();
    });
}

export function matchesFilter(record: RequestRecord, filter: RequestFilter): boolean {
  if (filter.host && !record.host?.toLowerCase().includes(filter.host.toLowerCase())) return false;
  if (filter.status && record.status !== filter.status) return false;
  if (filter.statusMin !== undefined && (record.status == null || record.status < filter.statusMin)) return false;
  if (filter.statusMax !== undefined && (record.status == null || record.status > filter.statusMax)) return false;
  if (filter.method && record.method?.toUpperCase() !== filter.method.toUpperCase()) return false;
  if (filter.search && !record.url?.toLowerCase().includes(filter.search.toLowerCase())) return false;
  if (filter.durationMin !== undefined && (record.duration == null || record.duration <= filter.durationMin)) return false;
  return true;
}

function tailRequests(port: number, filter: RequestFilter, format: string): void {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`Failed to connect to event stream (status ${res.statusCode}). Is the proxy running?`);
        process.exit(1);
      }

      if (format === 'table') {
        console.log(`\n  Tailing requests${filter.host ? ` (host: ${filter.host})` : ''}... (Ctrl+C to stop)\n`);
      }

      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // Parse SSE events from the buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = '';
          let data = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }

          if (eventType !== 'request' || !data) continue;

          try {
            const record = JSON.parse(data) as RequestRecord;
            if (matchesFilter(record, filter)) {
              console.log(formatTailLine(record, format));
            }
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
    console.error('Could not connect to proxy. Is it running?');
    process.exit(1);
  });

  req.end();
}

function parseTime(value: string): number {
  const num = Number(value);
  if (!isNaN(num)) return num;
  return new Date(value).getTime();
}
