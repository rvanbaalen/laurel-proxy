import pc from 'picocolors';
import type { RequestRecord, PaginatedResponse } from '../shared/types.js';

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

export function formatRequests(result: PaginatedResponse<RequestRecord>, format: string): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (result.data.length === 0) {
    return `\n  ${pc.dim('No requests found.')}\n`;
  }

  const header = pc.dim(
    '  ' +
    'METHOD'.padEnd(10) +
    'STATUS'.padEnd(8) +
    'HOST'.padEnd(32) +
    'PATH'.padEnd(32) +
    'TIME'.padEnd(10) +
    'SIZE'.padEnd(10)
  );

  const divider = pc.dim('  ' + '─'.repeat(100));

  const rows = result.data.map((r) => {
    return '  ' +
      methodColor(r.method || '').padEnd(10 + 10) + // extra for ANSI codes
      statusColor(r.status).padEnd(8 + 10) +
      (r.host || '').slice(0, 30).padEnd(32) +
      pc.dim((r.path || '').slice(0, 30)).padEnd(32 + 10) +
      pc.dim(r.duration ? `${r.duration}ms` : '-').padEnd(10 + 10) +
      pc.dim(formatBytes(r.response_size || 0));
  });

  const footer = `\n  ${pc.dim(`${result.total} total (showing ${result.data.length}, offset ${result.offset})`)}`;
  return ['', header, divider, ...rows, footer, ''].join('\n');
}

export function formatRequest(record: RequestRecord, format: string): string {
  if (format === 'json') {
    return JSON.stringify(record, null, 2);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
