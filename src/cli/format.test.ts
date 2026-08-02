import { describe, it, expect } from 'vitest';
import { formatRequests, formatRequest, formatTailLine, formatReplayResponse, formatDiff, formatThrottleSettings } from './format.js';
import type { RequestRecord, PaginatedResponse, ReplayResponse } from '../shared/types.js';
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
