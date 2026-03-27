import { describe, it, expect } from 'vitest';
import { formatRequests, formatRequest, formatTailLine } from './format.js';
import type { RequestRecord, PaginatedResponse } from '../shared/types.js';

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
