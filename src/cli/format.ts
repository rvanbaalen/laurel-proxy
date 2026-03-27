import pc from 'picocolors';
import type { RequestRecord, PaginatedResponse } from '../shared/types.js';

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

function toAgentRecord(r: RequestRecord) {
  return {
    summary: agentSummary(r),
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
      padAnsi(methodColor(r.method || ''), COL.method) +
      padAnsi(statusColor(r.status), COL.status) +
      (r.host || '').slice(0, COL.host - 2).padEnd(COL.host) +
      padAnsi(pc.dim((r.path || '').slice(0, COL.path - 2)), COL.path) +
      padAnsi(pc.dim(r.duration ? `${r.duration}ms` : '-'), COL.duration) +
      pc.dim(formatBytes(r.response_size || 0));
  });

  const footer = `\n  ${pc.dim(`${result.total} total (showing ${result.data.length}, offset ${result.offset})`)}`;
  return ['', header, divider, ...rows, footer, ''].join('\n');
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
    `  ${pc.dim('ID')}        ${record.id}`,
    `  ${pc.dim('URL')}       ${pc.cyan(record.url)}`,
    `  ${pc.dim('Method')}    ${methodColor(record.method)}`,
    `  ${pc.dim('Status')}    ${statusColor(record.status)}`,
    `  ${pc.dim('Duration')}  ${record.duration}ms`,
    `  ${pc.dim('Protocol')}  ${record.protocol}`,
    `  ${pc.dim('Time')}      ${new Date(record.timestamp).toISOString()}`,
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
      context: {
        is_error: r.status != null && r.status >= 400,
        content_type: r.content_type,
      },
    });
  }

  return '  ' +
    padAnsi(pc.dim(new Date(r.timestamp).toLocaleTimeString()), COL.time) +
    padAnsi(methodColor(r.method || ''), COL.method) +
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
