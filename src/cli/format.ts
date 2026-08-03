import pc from 'picocolors';
import type { RequestRecord, RequestKind, PaginatedResponse, ReplayResponse, ThrottleSettings, ThrottleProfile, WebSocketMessage } from '../shared/types.js';

// ── Shared column widths ──

export const COL = {
  time: 12,
  method: 8,
  status: 8,
  host: 30,
  path: 30,
  duration: 10,
  size: 10,
} as const;

// ── ANSI-safe padding ──

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(str: string): number {
  return str.replace(ANSI_RE, '').length;
}

function padAnsi(str: string, width: number): string {
  const pad = width - visibleLength(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

// ── Colors ──

const methodColor = (method: string): string => {
  switch (method) {
    case 'GET': return pc.blue(method);
    case 'POST': return pc.green(method);
    case 'PUT': return pc.yellow(method);
    case 'PATCH': return pc.magenta(method);
    case 'DELETE': return pc.red(method);
    default: return pc.dim(method);
  }
};

const statusColor = (status: number | null): string => {
  const s = String(status ?? '-');
  if (!status) return pc.dim(s);
  if (status < 300) return pc.green(s);
  if (status < 400) return pc.yellow(s);
  if (status < 500) return pc.magenta(s);
  return pc.red(s);
};

// ── Agent format helpers ──

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  return /text\/|application\/json|application\/xml|application\/javascript|application\/x-www-form-urlencoded/.test(contentType);
}

function decodeBody(body: Buffer | null, contentType: string | null, size: number): string | null {
  if (!body) return null;
  if (!isTextContentType(contentType)) {
    return `[binary response, ${formatBytes(size)}, content-type: ${contentType}]`;
  }
  return Buffer.isBuffer(body) ? body.toString('utf-8') : String(body);
}

function parseHeadersJson(headersJson: string | null): Record<string, unknown> | null {
  if (!headersJson) return null;
  try { return JSON.parse(headersJson); } catch { return null; }
}

function agentSummary(r: RequestRecord): string {
  const status = r.status ?? '?';
  const duration = r.duration ? ` (took ${r.duration}ms)` : '';
  return `${r.method} ${r.url} → ${status}${duration}`;
}

/**
 * The `kind` an agent (or a table row) should be told about.
 *
 * Defaulted rather than passed through: `kind` is optional on `RequestRecord` and
 * absent on every row written before the column existed, and `undefined` in
 * agent output would read as "unknown" for what is really an ordinary HTTP
 * request.
 */
function recordKind(r: RequestRecord): RequestKind {
  return r.kind ?? 'http';
}

/**
 * A compact marker for the traffic that is not an ordinary HTTP request.
 *
 * Only non-HTTP rows are tagged: a `kind` column carrying "http" on almost every
 * row would cost width on the format that is read by eye and say nothing. A
 * WebSocket handshake's method is always GET, so prefixing the method cell adds no
 * column and hides nothing.
 */
function kindMarker(r: RequestRecord): string {
  return recordKind(r) === 'websocket' ? `${pc.cyan('WS')} ` : '';
}

/**
 * A compact marker for a client hop that negotiated h2.
 *
 * Only h2 is tagged, matching `kindMarker`'s "only the non-default is worth a
 * character" rule — the default (http/1.1, or unknown) is left blank rather
 * than spelled out. Never co-occurs with `kindMarker`'s `WS` tag: a WebSocket
 * connection's client hop is h1.1 by construction (see `websocket.ts`), so
 * the two markers never compete for the same column width.
 */
function protocolMarker(r: RequestRecord): string {
  return r.client_protocol === 'h2' ? `${pc.magenta('H2')} ` : '';
}

/**
 * A wire-protocol value for display, distinguishing "unknown" from a guessed
 * default. `client_protocol`/`origin_protocol` are `null`/absent only when
 * genuinely not known (see the field docs in `src/shared/types.ts`) — never
 * silently rendering that as `'http/1.1'` is the whole point of the field.
 */
function wireProtocolLabel(value: RequestRecord['client_protocol']): string {
  return value === 'h2' || value === 'http/1.1' ? value : 'unknown';
}

function toAgentRecord(r: RequestRecord) {
  return {
    summary: agentSummary(r),
    /**
     * Without this an agent cannot tell a WebSocket connection from an HTTP
     * request, and so cannot discover which id to hand to
     * `laurel-proxy messages <id>` — the capture feature would have no
     * agent-side entry point.
     */
    kind: recordKind(r),
    /**
     * The two hops an h2 exchange has, exposed independently so an agent can
     * spot the case a plain `protocol` (URL scheme) field could never show:
     * an h2 client talking to an HTTP/1.1-only origin. `null` means genuinely
     * unknown and must be read as such, not as "http/1.1" — see
     * `RequestRecord.client_protocol`.
     */
    client_protocol: r.client_protocol ?? null,
    origin_protocol: r.origin_protocol ?? null,
    request: {
      method: r.method,
      url: r.url,
      host: r.host,
      headers: parseHeadersJson(r.request_headers),
      body_decoded: decodeBody(r.request_body, r.content_type, r.request_size),
      body_truncated: r.truncated === 1,
    },
    response: {
      status: r.status,
      status_text: r.status ? httpStatusText(r.status) : null,
      headers: parseHeadersJson(r.response_headers),
      body_decoded: decodeBody(r.response_body, r.content_type, r.response_size),
      body_truncated: r.truncated === 1,
    },
    timing: {
      duration_ms: r.duration,
      timestamp_iso: new Date(r.timestamp).toISOString(),
    },
    context: {
      is_error: r.status != null && r.status >= 400,
      content_type: r.content_type,
    },
  };
}

function httpStatusText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
    422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  return texts[status] ?? '';
}

// ── Table formatters ──

export function formatRequests(result: PaginatedResponse<RequestRecord>, format: string): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (format === 'agent') {
    const agentResult = {
      data: result.data.map(toAgentRecord),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
    return JSON.stringify(agentResult, null, 2);
  }

  if (result.data.length === 0) {
    return `\n  ${pc.dim('No requests found.')}\n`;
  }

  const totalWidth = COL.method + COL.status + COL.host + COL.path + COL.duration + COL.size;

  const header = pc.dim(
    '  ' +
    'METHOD'.padEnd(COL.method) +
    'STATUS'.padEnd(COL.status) +
    'HOST'.padEnd(COL.host) +
    'PATH'.padEnd(COL.path) +
    'TIME'.padEnd(COL.duration) +
    'SIZE'.padEnd(COL.size)
  );

  const divider = pc.dim('  ' + '─'.repeat(totalWidth));

  const rows = result.data.map((r) => {
    return '  ' +
      padAnsi(kindMarker(r) + protocolMarker(r) + methodColor(r.method || ''), COL.method) +
      padAnsi(statusColor(r.status), COL.status) +
      (r.host || '').slice(0, COL.host - 2).padEnd(COL.host) +
      padAnsi(pc.dim((r.path || '').slice(0, COL.path - 2)), COL.path) +
      padAnsi(pc.dim(r.duration ? `${r.duration}ms` : '-'), COL.duration) +
      pc.dim(formatBytes(r.response_size || 0));
  });

  const footer = `\n  ${pc.dim(`${result.total} total (showing ${result.data.length}, offset ${result.offset})`)}`;
  return ['', header, divider, ...rows, footer, ''].join('\n');
}

/**
 * One `label   value` line of a request's meta block.
 *
 * The padding is computed rather than typed out because it was typed out: the two
 * longest labels, `Client Hop` and `Origin Hop`, were padded to a different width
 * from every other row, so their values sat one character off. `META_LABEL_WIDTH`
 * is two wider than the longest label so that the next one added is aligned by
 * construction — and if it ever exceeds the width, the value keeps a single space
 * rather than running into the label.
 */
const META_LABEL_WIDTH = 12;

function metaLine(label: string, value: string): string {
  return `  ${pc.dim(label)}${' '.repeat(Math.max(1, META_LABEL_WIDTH - label.length))}${value}`;
}

export function formatRequest(record: RequestRecord, format: string): string {
  if (format === 'json') {
    return JSON.stringify(record, null, 2);
  }

  if (format === 'agent') {
    return JSON.stringify(toAgentRecord(record), null, 2);
  }

  const lines: string[] = [
    '',
    metaLine('ID', record.id),
    metaLine('URL', pc.cyan(record.url)),
    metaLine('Method', methodColor(record.method)),
    metaLine('Status', statusColor(record.status)),
    metaLine('Duration', `${record.duration}ms`),
    metaLine('Protocol', record.protocol),
    metaLine('Kind', recordKind(record)),
    metaLine('Client Hop', wireProtocolLabel(record.client_protocol)),
    metaLine('Origin Hop', wireProtocolLabel(record.origin_protocol)),
    metaLine('Time', new Date(record.timestamp).toISOString()),
    '',
    `  ${pc.bold('Request Headers')}`,
    formatHeaders(record.request_headers),
    '',
    `  ${pc.bold('Response Headers')}`,
    formatHeaders(record.response_headers),
  ];

  if (record.request_body) {
    lines.push('', `  ${pc.bold('Request Body')}`, formatBody(record.request_body, record.content_type));
  }
  if (record.response_body) {
    lines.push('', `  ${pc.bold('Response Body')}`, formatBody(record.response_body, record.content_type));
  }

  lines.push('');
  return lines.join('\n');
}

function formatHeaders(headersJson: string | null): string {
  if (!headersJson) return `  ${pc.dim('(none)')}`;
  try {
    const headers = JSON.parse(headersJson);
    return Object.entries(headers)
      .map(([k, v]) => `  ${pc.magenta(k)}${pc.dim(':')} ${v}`)
      .join('\n');
  } catch {
    return `  ${headersJson}`;
  }
}

function formatBody(body: Buffer | null, contentType: string | null): string {
  if (!body) return `  ${pc.dim('(empty)')}`;
  const str = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body);
  if (contentType?.includes('json')) {
    try {
      return str.split('\n').map(line => `  ${line}`).join('\n');
    } catch {}
  }
  return `  ${str}`;
}

export function formatTailLine(r: RequestRecord, format: string): string {
  if (format === 'json') {
    return JSON.stringify({
      id: r.id,
      timestamp: r.timestamp,
      method: r.method,
      status: r.status,
      host: r.host,
      path: r.path,
      url: r.url,
      duration: r.duration,
    });
  }

  if (format === 'agent') {
    return JSON.stringify({
      summary: agentSummary(r),
      // Same reason as `toAgentRecord`: an agent tailing traffic has to be able
      // to spot a WebSocket connection as it opens, not only in a later query.
      kind: recordKind(r),
      // Same reason again, for h2: an agent tailing traffic has to be able to
      // spot an h2 exchange (or a mixed-hops one) as it happens, not only in a
      // later `laurel-proxy request <id>` lookup.
      client_protocol: r.client_protocol ?? null,
      origin_protocol: r.origin_protocol ?? null,
      context: {
        is_error: r.status != null && r.status >= 400,
        content_type: r.content_type,
      },
    });
  }

  return '  ' +
    padAnsi(pc.dim(new Date(r.timestamp).toLocaleTimeString()), COL.time) +
    padAnsi(kindMarker(r) + protocolMarker(r) + methodColor(r.method || ''), COL.method) +
    padAnsi(statusColor(r.status), COL.status) +
    (r.host || '').slice(0, COL.host - 2).padEnd(COL.host) +
    padAnsi(pc.dim((r.path || '').slice(0, COL.path - 2)), COL.path) +
    pc.dim(r.duration ? `${r.duration}ms` : '-');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Replay response formatter (moved from cli/commands/replay.ts) ──

export function formatReplayResponse(response: ReplayResponse, format: string): string {
  if (format === 'json') {
    return JSON.stringify({
      ...response,
      body: Buffer.from(response.body, 'base64').toString('utf-8'),
    }, null, 2);
  }

  const lines: string[] = [
    '',
    `  ${pc.dim('Status')}    ${response.status < 400 ? pc.green(String(response.status)) : pc.red(String(response.status))}`,
    `  ${pc.dim('Duration')}  ${response.duration}ms`,
    `  ${pc.dim('Size')}      ${response.size}B`,
    '',
    `  ${pc.bold('Response Headers')}`,
  ];

  for (const [key, value] of Object.entries(response.headers)) {
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) {
      lines.push(`  ${pc.magenta(key)}${pc.dim(':')} ${v}`);
    }
  }

  const bodyStr = Buffer.from(response.body, 'base64').toString('utf-8');
  if (bodyStr) {
    lines.push('', `  ${pc.bold('Response Body')}`);
    let formatted = bodyStr;
    try { formatted = JSON.stringify(JSON.parse(bodyStr), null, 2); } catch {}
    lines.push(...formatted.split('\n').map(line => `  ${line}`));
  }

  lines.push('');
  return lines.join('\n');
}

// ── Diff formatter ──

type DiffResult = 'improved' | 'regressed' | 'changed' | 'unchanged';

function classifyDiff(originalStatus: number | null, replayStatus: number): DiffResult {
  if (originalStatus === replayStatus) return 'unchanged';
  const origError = originalStatus != null && originalStatus >= 400;
  const replayError = replayStatus >= 400;
  if (origError && !replayError) return 'improved';
  if (!origError && replayError) return 'regressed';
  return 'changed';
}

function decodeReplayBody(base64Body: string): string {
  return Buffer.from(base64Body, 'base64').toString('utf-8');
}

export function formatDiff(original: RequestRecord, replayResponse: ReplayResponse, format: string): string {
  const result = classifyDiff(original.status, replayResponse.status);
  const origBodyStr = decodeBody(original.response_body, original.content_type, original.response_size);
  const replayBodyStr = decodeReplayBody(replayResponse.body);
  const bodyChanged = origBodyStr !== replayBodyStr;
  const statusChanged = original.status !== replayResponse.status;
  const truncatedWarning = original.truncated === 1;

  if (format === 'json') {
    return JSON.stringify({
      original: { status: original.status, body: origBodyStr },
      replay: { status: replayResponse.status, body: replayBodyStr },
      changes: {
        status: statusChanged ? `${original.status} -> ${replayResponse.status}` : null,
        body_changed: bodyChanged,
      },
      result,
      ...(truncatedWarning ? { warning: 'Original body was truncated at capture time. Diff may not be accurate.' } : {}),
    }, null, 2);
  }

  if (format === 'agent') {
    return JSON.stringify({
      summary: `${original.method} ${original.url}: ${original.status} -> ${replayResponse.status} (${result})`,
      original_status: original.status,
      replay_status: replayResponse.status,
      status_changed: statusChanged,
      body_changed: bodyChanged,
      result,
      original_body_decoded: origBodyStr,
      replay_body_decoded: replayBodyStr,
      ...(truncatedWarning ? { warning: 'Original body was truncated at capture time. Diff may not be accurate.' } : {}),
    }, null, 2);
  }

  // Table/default format
  const lines: string[] = [''];

  if (truncatedWarning) {
    lines.push(`  ${pc.yellow('WARNING:')} Original body was truncated at capture time. Diff may not be accurate.`);
    lines.push('');
  }

  lines.push(`  ${pc.bold('DIFF:')} ${original.method} ${original.url}`);

  // Status
  const origStatusStr = `${original.status ?? '?'} ${original.status ? httpStatusText(original.status) : ''}`.trim();
  const replayStatusStr = `${replayResponse.status} ${httpStatusText(replayResponse.status)}`.trim();
  if (statusChanged) {
    lines.push(`  ${pc.dim('status:')}  ${statusColor(original.status)} ${pc.dim('->')} ${statusColor(replayResponse.status)}  ${pc.yellow('[CHANGED]')}`);
  } else {
    lines.push(`  ${pc.dim('status:')}  ${statusColor(original.status)}  ${pc.dim('[unchanged]')}`);
  }

  // Body
  if (bodyChanged) {
    lines.push(`  ${pc.dim('body:')}    ${pc.yellow('[CHANGED]')}`);
  } else {
    lines.push(`  ${pc.dim('body:')}    ${pc.dim('[unchanged]')}`);
  }

  // Timing
  if (original.duration != null) {
    lines.push(`  ${pc.dim('timing:')}  ${original.duration}ms ${pc.dim('->')} ${replayResponse.duration}ms`);
  }

  lines.push('');

  // Result
  const resultLabels: Record<DiffResult, string> = {
    improved: pc.green('IMPROVED') + ' (status changed from error to success)',
    regressed: pc.red('REGRESSED') + ' (status changed from success to error)',
    changed: pc.yellow('CHANGED') + ' (status changed)',
    unchanged: pc.dim('UNCHANGED') + ' (same status code)',
  };
  lines.push(`  ${pc.bold('RESULT:')} ${resultLabels[result]}`);
  lines.push('');

  return lines.join('\n');
}

// ── Throttle settings formatter ──

export function formatThrottleSettings(
  settings: ThrottleSettings,
  presets: Record<string, ThrottleProfile>,
  format: string,
): string {
  if (format === 'json') {
    return JSON.stringify({ settings, presets }, null, 2);
  }

  if (format === 'agent') {
    return JSON.stringify({
      enabled: settings.enabled,
      down_kbps: settings.downKbps,
      up_kbps: settings.upKbps,
      latency_ms: settings.latencyMs,
      available_presets: Object.keys(presets),
    });
  }

  const presetNames = Object.keys(presets).join(', ');

  if (!settings.enabled) {
    return [
      '',
      `  ${pc.dim('Throttling')}  disabled`,
      '',
      `  ${pc.dim('Presets:')} ${presetNames}`,
      `  Enable with: ${pc.cyan('laurel-proxy throttle <preset>')}`,
      '',
    ].join('\n');
  }

  return [
    '',
    `  ${pc.dim('Throttling')}  ${pc.green('enabled')}`,
    `  ${pc.dim('Download')}    ${settings.downKbps} kbps`,
    `  ${pc.dim('Upload')}      ${settings.upKbps} kbps`,
    `  ${pc.dim('Latency')}     ${settings.latencyMs} ms`,
    '',
    `  Disable with: ${pc.cyan('laurel-proxy throttle off')}`,
    '',
  ].join('\n');
}

// ── WebSocket message formatters ──

/**
 * Only a 'text' opcode is guaranteed by RFC 6455 to carry valid UTF-8.
 * 'binary' frames and control frames ('ping'/'pong'/'close') carry arbitrary
 * application bytes (a close frame's payload even starts with a 2-byte
 * numeric status code) — decoding those as UTF-8 can produce mojibake or
 * silently mangle bytes that aren't valid UTF-8. The REST API already
 * base64-encodes every opcode unconditionally for exactly this reason (see
 * `serializeWsMessage` in server/api.ts); CLI output must stay consistent
 * with that and state which encoding it used, rather than leaving a consumer
 * to guess from the key name alone.
 */
function wsPayloadEncoding(opcode: WebSocketMessage['opcode']): 'utf8' | 'base64' {
  return opcode === 'text' ? 'utf8' : 'base64';
}

/**
 * Decodes a frame's payload for a full collection record (json/agent),
 * tagging the encoding used. Kept full (not truncated) — a consumer parsing
 * JSON may be matching on payload content, so silently clipping it would be
 * worse than a large value; `truncated` (storage-side clipping) is reported
 * separately and untouched here.
 */
function encodeWsMessageForOutput(m: WebSocketMessage): Record<string, unknown> {
  const encoding = wsPayloadEncoding(m.opcode);
  const buf = m.payload ? Buffer.from(m.payload) : null;
  return {
    ...m,
    payload_encoding: encoding,
    payload: buf ? (encoding === 'utf8' ? buf.toString('utf8') : buf.toString('base64')) : null,
  };
}

/**
 * Same decoding as `encodeWsMessageForOutput`, but for a single streamed
 * line (`--follow`). Deliberately omits `id`/`request_id`: a `--follow`
 * session already filters to one connection, so repeating them on every
 * line would be redundant.
 */
function encodeWsMessageLineForOutput(message: WebSocketMessage): Record<string, unknown> {
  const encoding = wsPayloadEncoding(message.opcode);
  const full = message.payload ? Buffer.from(message.payload) : null;
  return {
    direction: message.direction,
    opcode: message.opcode,
    size: message.size,
    timestamp: message.timestamp,
    truncated: message.truncated,
    payload_encoding: encoding,
    payload: full ? (encoding === 'utf8' ? full.toString('utf8') : full.toString('base64')) : null,
  };
}

const WS_CONTROL_ESCAPES: Record<number, string> = {
  0x00: '\\0', 0x07: '\\a', 0x08: '\\b', 0x09: '\\t',
  0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x1b: '\\e',
};

/**
 * Neutralizes C0 control characters (including ESC, 0x7f DEL) before a
 * decoded payload reaches the terminal. A captured frame is untrusted
 * data — printing it raw would let an embedded ANSI escape sequence
 * repaint/hide the terminal, and an embedded newline would break the
 * one-line-per-message table layout this formatter promises.
 */
function escapeWsControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += WS_CONTROL_ESCAPES[code] ?? `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Single-line, terminal-safe preview of a frame's payload for table format. */
function wsPayloadPreview(message: WebSocketMessage, maxLength = 120): string {
  if (!message.payload) return '';
  // Only 'text' frames are safe to decode and display as UTF-8; binary and
  // control frames (ping/pong/close) carry arbitrary bytes, so show their
  // size instead of attempting a decode that could produce garbage.
  if (message.opcode !== 'text') return `<${message.size} bytes>`;
  const buf = Buffer.from(message.payload);
  const text = buf.toString('utf8');
  const isTruncated = text.length > maxLength;
  const escaped = escapeWsControlChars(isTruncated ? text.slice(0, maxLength) : text);
  return isTruncated ? `${escaped}…` : escaped;
}

export function formatWsMessages(
  result: PaginatedResponse<WebSocketMessage>,
  format: string,
): string {
  if (format === 'json' || format === 'agent') {
    const data = result.data.map(encodeWsMessageForOutput);
    const output: Record<string, unknown> = { ...result, data };
    if (format === 'agent') {
      const sent = result.data.filter((m) => m.direction === 'sent').length;
      const received = result.data.length - sent;
      // The total is collection-scoped and the breakdown is page-scoped, so the
      // summary has to say which is which. It previously read
      // "1200 messages captured (350 sent, 150 received)" for a 1200-frame
      // connection read at the default limit of 500 — three numbers that cannot
      // all describe the same set of frames, with nothing to say so.
      output.summary =
        `${result.total} message${result.total === 1 ? '' : 's'} captured; `
        + `showing ${result.data.length} (offset ${result.offset}): `
        + `${sent} sent, ${received} received`;
    }
    return JSON.stringify(output, null, 2);
  }

  // The page footer, in the same shape `formatRequests` has always used. A header
  // saying "1200 messages" above 500 rows presents a page as the whole
  // collection; the reader needs both numbers to know there is more to fetch.
  const pageNote = pc.dim(
    `${result.total} total (showing ${result.data.length}, offset ${result.offset})`,
  );

  if (result.data.length === 0) {
    // An offset past the end, or `--limit 0`, is a paging outcome rather than an
    // empty connection. Reporting it as "no messages captured" would describe a
    // choice the caller made as an absence of traffic.
    if (result.total === 0) {
      return `\n  ${pc.dim('No messages captured for this connection.')}\n`;
    }
    return `\n  ${pageNote}\n`;
  }

  const rows = result.data.map((m) => {
    const arrow = m.direction === 'sent' ? pc.green('→') : pc.blue('←');
    const time = pc.dim(new Date(m.timestamp).toISOString().slice(11, 23));
    const opcode = pc.dim(m.opcode.padEnd(6));
    const size = pc.dim(String(m.size).padStart(7));
    return `  ${time}  ${arrow}  ${opcode} ${size}  ${wsPayloadPreview(m)}`;
  });

  const header = `\n  ${pc.dim(`${result.total} message${result.total === 1 ? '' : 's'}`)}  (${pc.green('→')} client→server, ${pc.blue('←')} server→client)\n`;
  return [header, ...rows, `\n  ${pageNote}`, ''].join('\n');
}

export function formatWsMessageLine(message: WebSocketMessage, format: string): string {
  if (format === 'json' || format === 'agent') {
    const record = encodeWsMessageLineForOutput(message);
    if (format === 'agent') {
      const arrowLabel = message.direction === 'sent' ? 'client→server' : 'server→client';
      record.summary = `${arrowLabel} ${message.opcode} frame, ${message.size}B`;
    }
    return JSON.stringify(record);
  }
  const arrow = message.direction === 'sent' ? pc.green('→') : pc.blue('←');
  return `${arrow} ${message.opcode} ${message.size}B ${wsPayloadPreview(message)}`;
}
