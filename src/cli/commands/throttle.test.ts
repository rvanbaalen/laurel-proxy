import { describe, it, expect } from 'vitest';
import { parseRateOption, VALID_THROTTLE_FORMATS } from './throttle.js';

describe('parseRateOption', () => {
  it('returns undefined when the option was not supplied', () => {
    expect(parseRateOption(undefined, '--down')).toBeUndefined();
  });

  it('parses a legitimate zero, distinguishing it from "not supplied"', () => {
    // Commander hands CLI flag values over as strings, and "0" is truthy in
    // JS — `laurel-proxy throttle --latency 0` must produce 0, not undefined.
    expect(parseRateOption('0', '--latency')).toBe(0);
  });

  it('parses ordinary numeric strings', () => {
    expect(parseRateOption('780', '--down')).toBe(780);
  });

  it('throws a descriptive error for non-numeric input instead of yielding NaN', () => {
    // Bug found while reviewing the brief: Number('abc') is NaN, and
    // JSON.stringify({ downKbps: NaN }) serializes to `{"downKbps":null}`.
    // The server's PUT handler treats a null field as "not provided" (via
    // `??`) and silently falls back to the current setting — so a typo like
    // `--down abc` would produce no error at all, just an unexplained no-op.
    // Catching it here, before any network call, turns that into a clear
    // local failure.
    expect(() => parseRateOption('abc', '--down')).toThrow(/Invalid --down value "abc"/);
  });

  it('demonstrates why the check matters: NaN round-trips through JSON as null', () => {
    expect(JSON.stringify({ downKbps: Number('abc') })).toBe('{"downKbps":null}');
  });
});

describe('VALID_THROTTLE_FORMATS', () => {
  it('accepts agent alongside json and table', () => {
    // `agent` is a first-class output mode project-wide (see requests.ts and
    // the dedicated agent branches in format.ts) — `laurel-proxy throttle
    // 3g --format agent` must not be rejected the way an actually-invalid
    // format like `yaml` is.
    expect(VALID_THROTTLE_FORMATS).toContain('agent');
    expect(VALID_THROTTLE_FORMATS).toContain('json');
    expect(VALID_THROTTLE_FORMATS).toContain('table');
    expect(VALID_THROTTLE_FORMATS).not.toContain('yaml');
  });
});
