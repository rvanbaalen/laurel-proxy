import { describe, it, expect } from 'vitest';
import { buildFilter, matchesFilter } from './requests.js';
import type { RequestRecord } from '../../shared/types.js';

function makeRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'test-id',
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://example.com/test',
    host: 'example.com',
    path: '/test',
    protocol: 'http' as const,
    request_headers: '{}',
    request_body: null,
    request_size: 0,
    status: 200,
    response_headers: '{}',
    response_body: null,
    response_size: 0,
    duration: 100,
    content_type: 'text/html',
    truncated: 0,
    ...overrides,
  };
}

describe('buildFilter', () => {
  it('maps --failed to statusMin 400', () => {
    const filter = buildFilter({ failed: true });
    expect(filter.statusMin).toBe(400);
  });

  it('maps --last-hour to since within last hour', () => {
    const filter = buildFilter({ lastHour: true });
    const expected = Date.now() - 3600000;
    expect(Math.abs(filter.since! - expected)).toBeLessThanOrEqual(1000);
  });

  it('maps --last-day to since within last day', () => {
    const filter = buildFilter({ lastDay: true });
    const expected = Date.now() - 86400000;
    expect(Math.abs(filter.since! - expected)).toBeLessThanOrEqual(1000);
  });

  it('maps --slow to durationMin', () => {
    const filter = buildFilter({ slow: '500' });
    expect(filter.durationMin).toBe(500);
  });

  it('--status overrides --failed', () => {
    const filter = buildFilter({ status: '500', failed: true });
    expect(filter.status).toBe(500);
    expect(filter.statusMin).toBeUndefined();
  });
});

describe('matchesFilter', () => {
  it('checks statusMin range', () => {
    expect(matchesFilter(makeRecord({ status: 500 }), { statusMin: 400 })).toBe(true);
    expect(matchesFilter(makeRecord({ status: 200 }), { statusMin: 400 })).toBe(false);
  });

  it('checks statusMax range', () => {
    expect(matchesFilter(makeRecord({ status: 200 }), { statusMax: 399 })).toBe(true);
    expect(matchesFilter(makeRecord({ status: 500 }), { statusMax: 399 })).toBe(false);
  });

  it('checks durationMin', () => {
    expect(matchesFilter(makeRecord({ duration: 1000 }), { durationMin: 500 })).toBe(true);
    expect(matchesFilter(makeRecord({ duration: 100 }), { durationMin: 500 })).toBe(false);
  });
});
