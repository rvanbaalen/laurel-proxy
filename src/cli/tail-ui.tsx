import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import http from 'node:http';
import type { RequestFilter, RequestRecord } from '../shared/types.js';
import { loadConfig } from '../server/config.js';
import { Database } from '../storage/db.js';
import { COL } from './format.js';
import type { RoxyProxyServer } from '../server/index.js';
import { disableSystemProxy } from './system-proxy.js';

// ── Colors ──

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'yellow',
  PATCH: 'magenta',
  DELETE: 'red',
};

function statusColor(s: number | null): string {
  if (!s) return 'gray';
  if (s < 300) return 'green';
  if (s < 400) return 'yellow';
  if (s < 500) return 'magenta';
  return 'red';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Body helpers ──

function getContentTypeFromHeaders(headersJson: string): string | null {
  try {
    const h = JSON.parse(headersJson);
    const key = Object.keys(h).find(k => k.toLowerCase() === 'content-type');
    return key ? String(h[key]) : null;
  } catch { return null; }
}

function looksLikeJson(str: string): boolean {
  const trimmed = str.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

// ── Filter matching ──

function matchesFilter(record: RequestRecord, filter: RequestFilter): boolean {
  if (filter.host && !record.host?.toLowerCase().includes(filter.host.toLowerCase())) return false;
  if (filter.status && record.status !== filter.status) return false;
  if (filter.method && record.method?.toUpperCase() !== filter.method.toUpperCase()) return false;
  if (filter.search && !record.url?.toLowerCase().includes(filter.search.toLowerCase())) return false;
  return true;
}

// ── Filter label ──

function filterLabel(filter: RequestFilter): string {
  const parts: string[] = [];
  if (filter.host) parts.push(`host:${filter.host}`);
  if (filter.method) parts.push(`method:${filter.method}`);
  if (filter.status) parts.push(`status:${filter.status}`);
  if (filter.search) parts.push(`search:${filter.search}`);
  return parts.length ? parts.join(' ') : '';
}

// ── Detail View ──

type DetailTab = 'overview' | 'request' | 'response';
const TABS: { key: DetailTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'request', label: 'Request' },
  { key: 'response', label: 'Response' },
];

function DetailView({ record, onBack }: { record: RequestRecord; onBack: () => void }) {
  const [full, setFull] = useState<RequestRecord | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');

  useEffect(() => {
    try {
      const config = loadConfig();
      const db = new Database(config.dbPath);
      const result = db.getById(record.id);
      db.close();
      setFull(result);
    } catch {
      setFull(record);
    }
  }, [record.id]);

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.leftArrow || input === 'h') {
      const idx = TABS.findIndex(t => t.key === tab);
      if (idx > 0) setTab(TABS[idx - 1].key);
    }
    if (key.rightArrow || input === 'l') {
      const idx = TABS.findIndex(t => t.key === tab);
      if (idx < TABS.length - 1) setTab(TABS[idx + 1].key);
    }
    // Number keys for quick tab switching
    if (input === '1') setTab('overview');
    if (input === '2') setTab('request');
    if (input === '3') setTab('response');
  });

  const r = full ?? record;

  const parseHeaders = (raw: string | null): Record<string, string> => {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  };

  const decodeBody = (body: Buffer | string | null): string | null => {
    if (!body) return null;
    if (Buffer.isBuffer(body)) return body.toString('utf-8');
    // SSE records have base64-encoded bodies
    if (typeof body === 'string') {
      try { return Buffer.from(body, 'base64').toString('utf-8'); } catch { return body; }
    }
    return String(body);
  };

  const formatBody = (body: Buffer | string | null, headers: string | null): string => {
    const str = decodeBody(body);
    if (!str) return '(empty)';
    const ct = headers ? getContentTypeFromHeaders(headers) : null;
    const isJson = ct?.includes('json') || (!ct && looksLikeJson(str));
    if (isJson) {
      try {
        const pretty = JSON.stringify(JSON.parse(str), null, 2);
        return pretty.split('\n').map(line => `    ${line}`).join('\n');
      } catch { /* fallthrough */ }
    }
    return str.slice(0, 2000).split('\n').map(line => `    ${line}`).join('\n');
  };

  const renderHeaders = (raw: string | null) => {
    const headers = parseHeaders(raw);
    const entries = Object.entries(headers);
    if (entries.length === 0) return <Text dimColor>    (none)</Text>;
    return entries.map(([k, v]) => (
      <Box key={k}><Text color="magenta">    {k}</Text><Text dimColor>: </Text><Text>{String(v)}</Text></Box>
    ));
  };

  return (
    <Box flexDirection="column">
      {/* Summary line */}
      <Box marginBottom={1}>
        <Text color={METHOD_COLORS[r.method] ?? 'white'} bold>{r.method} </Text>
        <Text color={statusColor(r.status)}>{String(r.status ?? '-')} </Text>
        <Text color="cyan">{r.url}</Text>
        {r.duration && <Text dimColor>  {r.duration}ms</Text>}
      </Box>

      {/* Tab bar */}
      <Box>
        <Text>  </Text>
        {TABS.map((t, i) => (
          <React.Fragment key={t.key}>
            {i > 0 && <Text dimColor>  </Text>}
            {tab === t.key
              ? <Text bold color="cyan"> {t.label} </Text>
              : <Text dimColor> {t.label} </Text>
            }
          </React.Fragment>
        ))}
      </Box>
      <Text dimColor>  {'─'.repeat(40)}</Text>

      {/* Tab content */}
      {tab === 'overview' && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text dimColor>  ID        </Text><Text>{r.id}</Text></Box>
          <Box><Text dimColor>  URL       </Text><Text color="cyan">{r.url}</Text></Box>
          <Box><Text dimColor>  Method    </Text><Text color={METHOD_COLORS[r.method] ?? 'white'}>{r.method}</Text></Box>
          <Box><Text dimColor>  Status    </Text><Text color={statusColor(r.status)}>{String(r.status ?? '-')}</Text></Box>
          <Box><Text dimColor>  Duration  </Text><Text>{r.duration ? `${r.duration}ms` : '-'}</Text></Box>
          <Box><Text dimColor>  Protocol  </Text><Text>{r.protocol}</Text></Box>
          <Box><Text dimColor>  Time      </Text><Text>{new Date(r.timestamp).toISOString()}</Text></Box>
          <Box><Text dimColor>  Req Size  </Text><Text>{formatBytes(r.request_size || 0)}</Text></Box>
          <Box><Text dimColor>  Res Size  </Text><Text>{formatBytes(r.response_size || 0)}</Text></Box>
        </Box>
      )}

      {tab === 'request' && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text bold>  Headers</Text></Box>
          {renderHeaders(r.request_headers)}
          {r.request_body && (
            <>
              <Box marginTop={1}><Text bold>  Body</Text></Box>
              <Text>{formatBody(r.request_body, r.request_headers)}</Text>
            </>
          )}
          {!r.request_body && (
            <Box marginTop={1}><Text dimColor>  No request body</Text></Box>
          )}
        </Box>
      )}

      {tab === 'response' && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text bold>  Headers</Text></Box>
          {renderHeaders(r.response_headers)}
          {r.response_body && (
            <>
              <Box marginTop={1}><Text bold>  Body</Text></Box>
              <Text>{formatBody(r.response_body, r.response_headers)}</Text>
            </>
          )}
          {!r.response_body && (
            <Box marginTop={1}><Text dimColor>  No response body</Text></Box>
          )}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>  ←→ or h/l switch tabs  1/2/3 jump to tab  Esc back</Text>
      </Box>
    </Box>
  );
}

// ── Main Tail App ──

function TailApp({ port, filter, server, ownedSystemProxy }: { port: number; filter: RequestFilter; server: RoxyProxyServer | null; ownedSystemProxy: boolean }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [records, setRecords] = useState<RequestRecord[]>([]);
  const [cursor, setCursor] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<RequestRecord | null>(null);
  const autoScroll = useRef(true);

  const termHeight = stdout?.rows ?? 24;
  // Reserve rows for header (3), table header (2), footer (3)
  const visibleRows = Math.max(5, termHeight - 8);

  useEffect(() => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          setError(`Failed to connect (status ${res.statusCode}). Is the proxy running?`);
          return;
        }

        setConnected(true);
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
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
                setRecords(prev => {
                  const next = [record, ...prev];
                  // Keep max 500 records in memory
                  if (next.length > 500) next.length = 500;
                  return next;
                });
                // If cursor is at top (auto-scroll mode), keep it there
                if (autoScroll.current) {
                  setCursor(0);
                }
              }
            } catch {
              // Ignore malformed events
            }
          }
        });

        res.on('end', () => {
          setError('Event stream closed.');
        });
      },
    );

    req.on('error', () => {
      setError('Could not connect to proxy. Is it running?');
    });

    req.end();

    return () => { req.destroy(); };
  }, [port]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const cleanup = async () => {
        if (ownedSystemProxy) await disableSystemProxy();
        if (server) await server.stop();
        exit();
      };
      cleanup();
      return;
    }

    if (selectedRecord) {
      // Detail view handles its own input
      return;
    }

    if (key.upArrow) {
      setCursor(c => {
        const next = Math.max(0, c - 1);
        if (next === 0) autoScroll.current = true;
        else autoScroll.current = false;
        return next;
      });
    }
    if (key.downArrow) {
      setCursor(c => {
        autoScroll.current = false;
        return Math.min(records.length - 1, c + 1);
      });
    }

    // Page up/down
    if (key.pageUp || (key.shift && key.upArrow)) {
      setCursor(c => {
        const next = Math.max(0, c - visibleRows);
        if (next === 0) autoScroll.current = true;
        return next;
      });
    }
    if (key.pageDown || (key.shift && key.downArrow)) {
      setCursor(c => {
        autoScroll.current = false;
        return Math.min(records.length - 1, c + visibleRows);
      });
    }

    // Home - jump to top (newest)
    if (key.home || input === 'g') {
      setCursor(0);
      autoScroll.current = true;
    }
    // End - jump to bottom (oldest)
    if (key.end || input === 'G') {
      setCursor(Math.max(0, records.length - 1));
      autoScroll.current = false;
    }

    if (key.return && records[cursor]) {
      setSelectedRecord(records[cursor]);
    }
  });

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (selectedRecord) {
    return (
      <Box flexDirection="column" padding={1}>
        <DetailView record={selectedRecord} onBack={() => setSelectedRecord(null)} />
      </Box>
    );
  }

  // Calculate visible window
  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), records.length - visibleRows));
  const visibleRecords = records.slice(scrollStart, scrollStart + visibleRows);

  const fl = filterLabel(filter);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box>
        <Text bold color="cyan"> Tailing requests</Text>
        {fl && <Text dimColor>  ({fl})</Text>}
        <Text> </Text>
        {connected
          ? <Text color="green">● connected</Text>
          : <Text color="yellow">○ connecting...</Text>
        }
        {records.length > 0 && <Text dimColor>  {records.length} captured</Text>}
      </Box>
      <Text> </Text>

      {/* Table header */}
      <Box>
        <Text dimColor>
          {'  '}
          {'TIME'.padEnd(COL.time)}
          {'METHOD'.padEnd(COL.method)}
          {'STATUS'.padEnd(COL.status)}
          {'HOST'.padEnd(COL.host)}
          {'PATH'.padEnd(COL.path)}
          {'DURATION'}
        </Text>
      </Box>
      <Text dimColor>{'  ' + '─'.repeat(COL.time + COL.method + COL.status + COL.host + COL.path + COL.duration)}</Text>

      {/* Records */}
      {records.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>  Waiting for requests...</Text>
        </Box>
      ) : (
        visibleRecords.map((r, i) => {
          const globalIdx = scrollStart + i;
          const selected = globalIdx === cursor;
          const time = new Date(r.timestamp).toLocaleTimeString();
          return (
            <Box key={r.id}>
              <Text color="cyan">{selected ? '> ' : '  '}</Text>
              <Text dimColor>{time.padEnd(COL.time)}</Text>
              <Text color={METHOD_COLORS[r.method] ?? 'white'}>{r.method.padEnd(COL.method)}</Text>
              <Text color={statusColor(r.status)}>{String(r.status ?? '-').padEnd(COL.status)}</Text>
              <Text>{(r.host || '').slice(0, COL.host - 2).padEnd(COL.host)}</Text>
              <Text dimColor>{(r.path || '').slice(0, COL.path - 2).padEnd(COL.path)}</Text>
              <Text dimColor>{r.duration ? `${r.duration}ms` : '-'}</Text>
            </Box>
          );
        })
      )}

      {/* Scroll indicator */}
      {records.length > visibleRows && (
        <Box marginTop={0}>
          <Text dimColor>
            {'  '}
            {scrollStart > 0 ? '↑ more' : '      '}
            {'  '}
            {scrollStart + visibleRows < records.length ? '↓ more' : '      '}
            {'  '}
            ({cursor + 1}/{records.length})
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>  ↑↓ navigate  Enter detail  g/G top/bottom  Ctrl+C quit</Text>
        {autoScroll.current && records.length > 0 && <Text color="green">  [auto-scroll]</Text>}
      </Box>
    </Box>
  );
}

export function launchTailUi(port: number, filter: RequestFilter, server?: RoxyProxyServer | null, ownedSystemProxy = false): void {
  render(<TailApp port={port} filter={filter} server={server ?? null} ownedSystemProxy={ownedSystemProxy} />);
}
