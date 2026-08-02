import { describe, it, expect } from 'vitest';
import { formatRequests, formatRequest, formatTailLine, formatReplayResponse, formatDiff, formatThrottleSettings, formatWsMessages, formatWsMessageLine } from './format.js';
import type { RequestRecord, PaginatedResponse, ReplayResponse, WebSocketMessage } from '../shared/types.js';
import { THROTTLE_PRESETS } from '../server/throttle.js';

function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'test-id',
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://example.com/test',
    host: 'example.com',
    path: '/test',
    protocol: 'http' as const,
    request_headers: '{"host":"example.com"}',
    request_body: null,
    request_size: 0,
    status: 200,
    response_headers: '{"content-type":"application/json"}',
    response_body: Buffer.from('{"ok":true}'),
    response_size: 11,
    duration: 100,
    content_type: 'application/json',
    truncated: 0,
    ...overrides,
  };
}

describe('formatRequests agent format', () => {
  it('returns array of enriched records', () => {
    const result: PaginatedResponse<RequestRecord> = {
      data: [makeRequest()],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const output = formatRequests(result, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveLength(1);
    const record = parsed.data[0];
    expect(record).toHaveProperty('summary');
    expect(record).toHaveProperty('request');
    expect(record).toHaveProperty('response');
    expect(record).toHaveProperty('timing');
    expect(record).toHaveProperty('context');
  });

  it('includes is_error for 4xx/5xx', () => {
    const result: PaginatedResponse<RequestRecord> = {
      data: [makeRequest({ status: 200 }), makeRequest({ status: 500 })],
      total: 2,
      limit: 50,
      offset: 0,
    };
    const output = formatRequests(result, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.data[0].context.is_error).toBe(false);
    expect(parsed.data[1].context.is_error).toBe(true);
  });

  it('decodes Buffer bodies to strings', () => {
    const result: PaginatedResponse<RequestRecord> = {
      data: [makeRequest({ response_body: Buffer.from('{"hello":"world"}') })],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const output = formatRequests(result, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.data[0].response.body_decoded).toBe('{"hello":"world"}');
  });
});

describe('formatRequest agent format', () => {
  it('includes full schema', () => {
    const record = makeRequest();
    const output = formatRequest(record, 'agent');
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(['summary', 'request', 'response', 'timing', 'context']),
    );
  });

  it('handles null response_body', () => {
    const record = makeRequest({ response_body: null });
    const output = formatRequest(record, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.response.body_decoded).toBeNull();
  });

  it('handles truncated body', () => {
    const record = makeRequest({ truncated: 1 });
    const output = formatRequest(record, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.response.body_truncated).toBe(true);
  });

  it('shows placeholder for binary bodies', () => {
    const record = makeRequest({
      content_type: 'image/png',
      response_body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      response_size: 4096,
    });
    const output = formatRequest(record, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.response.body_decoded).toMatch(/^\[binary response,/);
  });
});

describe('formatTailLine agent format', () => {
  it('returns compact JSON', () => {
    const record = makeRequest();
    const output = formatTailLine(record, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('summary');
    expect(parsed.context).toHaveProperty('is_error');
  });
});

// ── formatReplayResponse ──

function makeReplayResponse(overrides: Partial<ReplayResponse> = {}): ReplayResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"ok":true}').toString('base64'),
    duration: 50,
    size: 11,
    ...overrides,
  };
}

describe('formatReplayResponse', () => {
  it('outputs JSON with decoded body', () => {
    const response = makeReplayResponse();
    const output = formatReplayResponse(response, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('{"ok":true}');
  });

  it('outputs table format with status and body', () => {
    const response = makeReplayResponse({ status: 422 });
    const output = formatReplayResponse(response, 'table');
    expect(output).toContain('422');
    expect(output).toContain('Response Body');
  });
});

// ── formatDiff ──

describe('formatDiff', () => {
  it('classifies as improved when error becomes success', () => {
    const original = makeRequest({ status: 422, response_body: Buffer.from('{"error":"bad"}') });
    const replay = makeReplayResponse({ status: 200 });
    const output = formatDiff(original, replay, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.result).toBe('improved');
    expect(parsed.changes.status).toBe('422 -> 200');
    expect(parsed.changes.body_changed).toBe(true);
  });

  it('classifies as unchanged when same status', () => {
    const body = Buffer.from('{"ok":true}');
    const original = makeRequest({ status: 200, response_body: body });
    const replay = makeReplayResponse({ status: 200, body: body.toString('base64') });
    const output = formatDiff(original, replay, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.result).toBe('unchanged');
    expect(parsed.changes.status).toBeNull();
    expect(parsed.changes.body_changed).toBe(false);
  });

  it('classifies as regressed when success becomes error', () => {
    const original = makeRequest({ status: 200, response_body: Buffer.from('{"ok":true}') });
    const replay = makeReplayResponse({ status: 500, body: Buffer.from('{"error":"server"}').toString('base64') });
    const output = formatDiff(original, replay, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.result).toBe('regressed');
  });

  it('handles null original body', () => {
    const original = makeRequest({ status: 422, response_body: null, response_size: 0 });
    const replay = makeReplayResponse({ status: 200 });
    const output = formatDiff(original, replay, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.result).toBe('improved');
    expect(parsed.changes.body_changed).toBe(true);
  });

  it('handles non-JSON bodies in table format', () => {
    const original = makeRequest({
      status: 422,
      response_body: Buffer.from('plain text error'),
      content_type: 'text/plain',
    });
    const replay = makeReplayResponse({
      status: 200,
      body: Buffer.from('plain text ok').toString('base64'),
    });
    const output = formatDiff(original, replay, 'table');
    expect(output).toContain('CHANGED');
    expect(output).toContain('IMPROVED');
  });

  it('includes truncation warning when body was truncated', () => {
    const original = makeRequest({ status: 422, truncated: 1 });
    const replay = makeReplayResponse({ status: 200 });
    const jsonOutput = formatDiff(original, replay, 'json');
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.warning).toContain('truncated');

    const tableOutput = formatDiff(original, replay, 'table');
    expect(tableOutput).toContain('WARNING');
  });

  it('outputs agent format with summary', () => {
    const original = makeRequest({
      status: 422,
      method: 'POST',
      url: 'http://api.test/webhook',
      response_body: Buffer.from('{"error":"bad"}'),
    });
    const replay = makeReplayResponse({ status: 200 });
    const output = formatDiff(original, replay, 'agent');
    const parsed = JSON.parse(output);
    expect(parsed.summary).toContain('POST');
    expect(parsed.summary).toContain('422');
    expect(parsed.summary).toContain('200');
    expect(parsed.summary).toContain('improved');
    expect(parsed.result).toBe('improved');
    expect(parsed.status_changed).toBe(true);
    expect(parsed.body_changed).toBe(true);
  });
});

// ── formatThrottleSettings ──

describe('formatThrottleSettings', () => {
  it('reports disabled state in table format', () => {
    const out = formatThrottleSettings(
      { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 },
      THROTTLE_PRESETS,
      'table',
    );
    expect(out).toContain('disabled');
  });

  it('reports active rates in table format', () => {
    const out = formatThrottleSettings(
      { enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 },
      THROTTLE_PRESETS,
      'table',
    );
    expect(out).toContain('780');
    expect(out).toContain('330');
    expect(out).toContain('100');
  });

  it('emits parseable JSON', () => {
    const out = formatThrottleSettings(
      { enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 },
      THROTTLE_PRESETS,
      'json',
    );
    expect(JSON.parse(out).settings.downKbps).toBe(780);
  });

  it('lists preset names when disabled', () => {
    const out = formatThrottleSettings(
      { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 },
      THROTTLE_PRESETS,
      'table',
    );
    for (const name of Object.keys(THROTTLE_PRESETS)) {
      expect(out).toContain(name);
    }
  });

  it('emits a compact agent record when enabled', () => {
    const out = formatThrottleSettings(
      { enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 },
      THROTTLE_PRESETS,
      'agent',
    );
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      enabled: true,
      down_kbps: 780,
      up_kbps: 330,
      latency_ms: 100,
      available_presets: Object.keys(THROTTLE_PRESETS),
    });
  });

  it('emits a compact agent record when disabled', () => {
    const out = formatThrottleSettings(
      { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 },
      THROTTLE_PRESETS,
      'agent',
    );
    const parsed = JSON.parse(out);
    expect(parsed.enabled).toBe(false);
    expect(parsed.available_presets).toEqual(Object.keys(THROTTLE_PRESETS));
  });
});

// ── formatWsMessages / formatWsMessageLine ──

function wsMessage(over: Partial<WebSocketMessage> = {}): WebSocketMessage {
  return {
    id: 'm1', request_id: 'c1', timestamp: 1735689600000, direction: 'sent',
    opcode: 'text', payload: Buffer.from('{"op":1}'), size: 8, truncated: 0, ...over,
  };
}

describe('formatWsMessages', () => {
  it('renders direction arrows in table format', () => {
    const out = formatWsMessages(
      { data: [wsMessage(), wsMessage({ id: 'm2', direction: 'received' })], total: 2, limit: 500, offset: 0 },
      'table',
    );
    expect(out).toContain('→');
    expect(out).toContain('←');
  });

  it('emits parseable JSON with decoded text payloads', () => {
    const out = formatWsMessages(
      { data: [wsMessage()], total: 1, limit: 500, offset: 0 },
      'json',
    );
    expect(JSON.parse(out).data[0].payload).toBe('{"op":1}');
  });

  it('reports an empty connection', () => {
    const out = formatWsMessages({ data: [], total: 0, limit: 500, offset: 0 }, 'table');
    expect(out).toContain('No messages');
  });

  it('marks binary payloads by size rather than dumping bytes', () => {
    const out = formatWsMessages(
      { data: [wsMessage({ opcode: 'binary', payload: Buffer.alloc(64), size: 64 })], total: 1, limit: 500, offset: 0 },
      'table',
    );
    expect(out).toContain('binary');
    expect(out).toContain('64');
  });

  it('tags text payloads as utf8 and binary payloads as base64 in json format', () => {
    const out = formatWsMessages(
      {
        data: [
          wsMessage({ id: 'm1', opcode: 'text' }),
          wsMessage({ id: 'm2', opcode: 'binary', payload: Buffer.from([0, 1, 2]), size: 3 }),
        ],
        total: 2, limit: 500, offset: 0,
      },
      'json',
    );
    const parsed = JSON.parse(out);
    expect(parsed.data[0].payload_encoding).toBe('utf8');
    expect(parsed.data[1].payload_encoding).toBe('base64');
    expect(parsed.data[1].payload).toBe(Buffer.from([0, 1, 2]).toString('base64'));
  });

  it('treats ping/pong/close control frames as opaque bytes, not text', () => {
    // RFC 6455 control frames carry arbitrary application data (ping/pong) or
    // a binary status code (close) — decoding them as UTF-8 can produce
    // mojibake or silently mangle non-UTF-8 bytes, the same failure mode the
    // brief already flagged for 'binary'. They must be base64, and the table
    // preview must not attempt to decode them either.
    for (const opcode of ['ping', 'pong', 'close'] as const) {
      const jsonOut = formatWsMessages(
        { data: [wsMessage({ opcode, payload: Buffer.from([0xff, 0x00, 0x10]), size: 3 })], total: 1, limit: 500, offset: 0 },
        'json',
      );
      const parsed = JSON.parse(jsonOut);
      expect(parsed.data[0].payload_encoding).toBe('base64');

      const tableOut = formatWsMessages(
        { data: [wsMessage({ opcode, payload: Buffer.from([0xff, 0x00, 0x10]), size: 3 })], total: 1, limit: 500, offset: 0 },
        'table',
      );
      expect(tableOut).toContain('3 bytes');
    }
  });

  it('escapes control characters in the table preview instead of printing them raw', () => {
    // An embedded ESC (0x1b) could otherwise inject an ANSI escape sequence
    // into the terminal, and an embedded newline/CR/tab would break the
    // one-line-per-message layout this formatter promises. A character-class
    // exclusion over the whole output can't tell "escaped" from "absent", so
    // this asserts directly on the escaped literal text and on the layout
    // property itself.
    const payload = Buffer.from('before\x1b[31mred\ntab\tend\rafter');
    const out = formatWsMessages(
      { data: [wsMessage({ payload, size: payload.length })], total: 1, limit: 500, offset: 0 },
      'table',
    );

    // The message must still occupy exactly one printed line: split on real
    // newlines and find the row containing 'before'. If \n (or \r) weren't
    // escaped, 'after' would land on a different split-line than 'before',
    // and this line-scoped lookup would come up empty for it.
    const rowLine = out.split('\n').find((line) => line.includes('before'));
    expect(rowLine).toBeDefined();
    expect(rowLine).toContain('after');

    // The escape sequences themselves must be visible as literal text, not
    // silently dropped or passed through raw.
    expect(rowLine).toContain('\\e'); // ESC
    expect(rowLine).toContain('\\n'); // embedded newline
    expect(rowLine).toContain('\\t'); // embedded tab
    expect(rowLine).toContain('\\r'); // embedded carriage return
    // No raw ANSI injection from payload content (distinct from picocolors'
    // own green/blue/dim codes used elsewhere on the same line).
    expect(rowLine).not.toContain('\x1b[31m');
  });

  it('includes a human-readable summary in agent format', () => {
    const out = formatWsMessages(
      { data: [wsMessage(), wsMessage({ id: 'm2', direction: 'received' })], total: 2, limit: 500, offset: 0 },
      'agent',
    );
    const parsed = JSON.parse(out);
    expect(parsed.summary).toContain('2 message');
    expect(parsed.data[0].payload_encoding).toBe('utf8');
  });

  it('carries the full payload uncut in json/agent format, unlike the truncated table preview', () => {
    // Same no-silent-truncation property already guarded for
    // formatWsMessageLine (the streaming path), pinned here for the
    // collection path too so encodeWsMessageForOutput and
    // encodeWsMessageLineForOutput can't drift apart on this.
    const longText = 'x'.repeat(1000);
    const message = wsMessage({ payload: Buffer.from(longText), size: 1000 });

    const jsonOut = formatWsMessages({ data: [message], total: 1, limit: 500, offset: 0 }, 'json');
    const parsedJson = JSON.parse(jsonOut).data[0].payload;
    expect(parsedJson).toBe(longText);
    expect(parsedJson.length).toBe(1000);

    const agentOut = formatWsMessages({ data: [message], total: 1, limit: 500, offset: 0 }, 'agent');
    expect(JSON.parse(agentOut).data[0].payload).toBe(longText);

    const tableOut = formatWsMessages({ data: [message], total: 1, limit: 500, offset: 0 }, 'table');
    expect(tableOut).not.toContain(longText);
  });
});

describe('formatWsMessageLine', () => {
  it('renders one line per message for streaming', () => {
    // Not a raw substring check: the payload itself contains quote
    // characters ('{"op":1}'), which JSON.stringify must escape when
    // embedding it as a string value — `.toContain('{"op":1}')` against the
    // raw JSON text can never pass no matter how correct the implementation
    // is. Parse first, then assert on the decoded value.
    const parsed = JSON.parse(formatWsMessageLine(wsMessage(), 'agent'));
    expect(parsed.payload).toBe('{"op":1}');
  });

  it('carries the full payload uncut, unlike the truncated table preview', () => {
    // Machine-readable streaming output must never silently clip a payload —
    // that's a different concern from `truncated`, which reflects storage
    // clipping. This must hold even past the table preview's 120-char cutoff.
    const longText = 'x'.repeat(1000);
    const message = wsMessage({ payload: Buffer.from(longText), size: 1000 });
    const jsonLine = formatWsMessageLine(message, 'json');
    const parsed = JSON.parse(jsonLine);
    expect(parsed.payload).toBe(longText);
    expect(parsed.payload.length).toBe(1000);

    const tablePreview = formatWsMessageLine(message, 'table');
    expect(tablePreview).not.toContain(longText);
  });

  it('reports payload_encoding for both text and binary opcodes', () => {
    const textOut = JSON.parse(formatWsMessageLine(wsMessage({ opcode: 'text' }), 'json'));
    expect(textOut.payload_encoding).toBe('utf8');

    const binPayload = Buffer.from([10, 20, 30]);
    const binOut = JSON.parse(
      formatWsMessageLine(wsMessage({ opcode: 'binary', payload: binPayload, size: 3 }), 'json'),
    );
    expect(binOut.payload_encoding).toBe('base64');
    expect(binOut.payload).toBe(binPayload.toString('base64'));
  });

  it('preserves the truncated flag distinctly from payload completeness', () => {
    const message = wsMessage({ truncated: 1, payload: Buffer.from('clipped-at-storage') });
    const parsed = JSON.parse(formatWsMessageLine(message, 'json'));
    expect(parsed.truncated).toBe(1);
    expect(parsed.payload).toBe('clipped-at-storage');
  });

  it('includes a human-readable summary in agent format', () => {
    const parsed = JSON.parse(formatWsMessageLine(wsMessage({ direction: 'received' }), 'agent'));
    expect(parsed.summary).toContain('server');
  });
});
