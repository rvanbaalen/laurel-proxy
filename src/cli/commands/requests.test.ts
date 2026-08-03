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

  it('maps --kind to a kind filter', () => {
    expect(buildFilter({ kind: 'websocket' }).kind).toBe('websocket');
    expect(buildFilter({ kind: 'http' }).kind).toBe('http');
  });

  it('ignores an unrecognised --kind rather than filtering on a value nothing can match', () => {
    // The command validates and exits before reaching here; a silently-applied
    // bogus value would return an empty list that looks like "no such traffic".
    expect(buildFilter({ kind: 'webscoket' }).kind).toBeUndefined();
    expect(buildFilter({}).kind).toBeUndefined();
  });

  it('maps --client-protocol and --origin-protocol independently', () => {
    const filter = buildFilter({ clientProtocol: 'h2', originProtocol: 'http/1.1' });
    expect(filter.clientProtocol).toBe('h2');
    expect(filter.originProtocol).toBe('http/1.1');
  });

  it('ignores an unrecognised --client-protocol/--origin-protocol rather than filtering on a value nothing can match', () => {
    expect(buildFilter({ clientProtocol: 'h3' }).clientProtocol).toBeUndefined();
    expect(buildFilter({ originProtocol: 'h3' }).originProtocol).toBeUndefined();
    expect(buildFilter({}).clientProtocol).toBeUndefined();
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

  it('checks kind, treating an absent kind as http', () => {
    // `--tail` filters live SSE records through here rather than through SQL, so
    // `--kind` has to mean the same thing on both paths or the same flag would
    // select different traffic depending on whether you were tailing.
    expect(matchesFilter(makeRecord({ kind: 'websocket' }), { kind: 'websocket' })).toBe(true);
    expect(matchesFilter(makeRecord({ kind: 'http' }), { kind: 'websocket' })).toBe(false);
    expect(matchesFilter(makeRecord(), { kind: 'http' })).toBe(true);
    expect(matchesFilter(makeRecord(), { kind: 'websocket' })).toBe(false);
  });

  it('checks clientProtocol and originProtocol independently, with no NULL-inclusion fallback', () => {
    // Unlike `kind`, an absent/null protocol must not satisfy either filter
    // value — see the note on `RequestFilter.clientProtocol`.
    expect(matchesFilter(makeRecord({ client_protocol: 'h2' }), { clientProtocol: 'h2' })).toBe(true);
    expect(matchesFilter(makeRecord({ client_protocol: 'http/1.1' }), { clientProtocol: 'h2' })).toBe(false);
    expect(matchesFilter(makeRecord(), { clientProtocol: 'http/1.1' })).toBe(false);
    expect(matchesFilter(makeRecord(), { clientProtocol: 'h2' })).toBe(false);

    expect(
      matchesFilter(
        makeRecord({ client_protocol: 'h2', origin_protocol: 'http/1.1' }),
        { clientProtocol: 'h2', originProtocol: 'http/1.1' },
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        makeRecord({ client_protocol: 'h2', origin_protocol: 'h2' }),
        { clientProtocol: 'h2', originProtocol: 'http/1.1' },
      ),
    ).toBe(false);
  });
});
