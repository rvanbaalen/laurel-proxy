import { describe, it, expect, vi } from 'vitest';
import { RateLimiter, Throttler, THROTTLE_PRESETS, kbpsToBytesPerSec, validateThrottleSettings } from './throttle.js';
import type { Clock } from './throttle.js';

/**
 * Deterministic clock: sleep advances virtual time instantly by adding its
 * `ms` to a shared counter. This models "sum of all sleep durations", NOT
 * elapsed wall-clock time — it cannot distinguish two overlapping 500ms
 * waits (which should still total 500ms of real time) from two sequential
 * ones (which correctly total 1000ms), because it just accumulates every
 * call's `ms` unconditionally. That makes it fine — and the only honest
 * option — for the single-consumer arithmetic tests below, but structurally
 * incapable of guarding shared-pipe concurrency. The concurrency test
 * further down deliberately uses `vi.useFakeTimers()` instead; do not
 * "simplify" it back to this helper.
 */
function fakeClock(): Clock & { elapsed: number } {
  const c = {
    elapsed: 0,
    now: () => c.elapsed,
    sleep: async (ms: number) => { c.elapsed += ms; },
  };
  return c;
}

describe('kbpsToBytesPerSec', () => {
  it('converts kilobits per second to bytes per second', () => {
    expect(kbpsToBytesPerSec(8)).toBe(1000);
    expect(kbpsToBytesPerSec(1000)).toBe(125_000);
  });

  it('treats a non-finite rate as unlimited rather than passing NaN on', () => {
    // Defence in depth behind `validateThrottleSettings`. NaN fails every
    // comparison, so the old `kbps <= 0` guard let it through and returned NaN;
    // `RateLimiter` then short-circuited on `Math.ceil(NaN) > 0` and paced
    // nothing, while the settings it was built from still read "enabled".
    // Returning 0 makes that state an honestly unlimited limiter.
    expect(kbpsToBytesPerSec(NaN)).toBe(0);
    expect(kbpsToBytesPerSec(Infinity)).toBe(0);
    expect(kbpsToBytesPerSec(-Infinity)).toBe(0);
  });
});

describe('validateThrottleSettings', () => {
  const fallback = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0 };

  it('accepts a complete, valid object', () => {
    expect(validateThrottleSettings({ enabled: true, downKbps: 1, upKbps: 2, latencyMs: 3 }, fallback))
      .toEqual({ settings: { enabled: true, downKbps: 1, upKbps: 2, latencyMs: 3 } });
  });

  it('fills absent fields from the fallback', () => {
    expect(validateThrottleSettings({ downKbps: 500 }, { ...fallback, enabled: true, latencyMs: 7 }))
      .toEqual({ settings: { enabled: true, downKbps: 500, upKbps: 0, latencyMs: 7 } });
  });

  it('treats an explicit null as an absent field, never as a rate', () => {
    // `??` semantics, matching the endpoint's documented "omitted fields fall
    // back to the current setting" — a JSON `null` is how plenty of clients spell
    // "not set". The property that matters is that it cannot become a rate: the
    // result is a finite fallback value that the settings then report honestly,
    // not a NaN the limiter would silently ignore while claiming to be enabled.
    const result = validateThrottleSettings({ enabled: true, downKbps: null }, fallback);
    expect(result).toEqual({ settings: { enabled: true, downKbps: 0, upKbps: 0, latencyMs: 0 } });
  });

  it('rejects the inputs that made the config file lie about being enabled', () => {
    for (const input of [
      { enabled: 'false' },
      { enabled: true, upKbps: 'fast' },
      { enabled: true, latencyMs: NaN },
      { enabled: true, downKbps: Infinity },
      { enabled: true, downKbps: -1 },
      { enabled: true, downKbps: { not: 'a number' } },
    ]) {
      const result = validateThrottleSettings(input, fallback);
      expect(result, JSON.stringify(input)).toHaveProperty('error');
    }
  });
});

describe('RateLimiter', () => {
  it('does not delay when the rate is unlimited', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(0, clock);
    await limiter.consume(10_000_000);
    expect(clock.elapsed).toBe(0);
  });

  it('paces a single consumer to the configured rate', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock); // 1000 B/s
    await limiter.consume(1000);
    expect(clock.elapsed).toBe(1000); // 1 second for 1000 bytes
  });

  // This test must use Vitest fake timers, NOT the fakeClock helper above.
  // fakeClock.sleep() adds its `ms` to `elapsed` unconditionally, so it models
  // "sum of all sleeps" rather than elapsed wall-clock time: two overlapping
  // 500ms waits total 1000ms there, identical to correct serialised behaviour.
  // That makes the helper structurally incapable of detecting a regression that
  // yields before committing the reservation. vi.useFakeTimers() mocks Date.now
  // and setTimeout coherently, so overlap is modelled properly.
  it('serialises genuinely concurrent consumers onto one shared pipe', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1000); // default realClock, both faked
      const startedAt = Date.now();
      let completed = 0;
      const both = Promise.all([
        limiter.consume(500).then(() => { completed++; }),
        limiter.consume(500).then(() => { completed++; }),
      ]);

      // After 500ms only the FIRST reservation may have completed. If the
      // implementation yielded before committing, both would have reserved
      // 0-500ms and both would finish here — which is the regression.
      await vi.advanceTimersByTimeAsync(500);
      expect(completed).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      await both;
      expect(completed).toBe(2);
      expect(Date.now() - startedAt).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never rounds a small nonzero rate down to unlimited', async () => {
    const clock = fakeClock();
    // 0.001 kbps would round to 0 B/s, and 0 is the "unlimited" sentinel —
    // a very slow link must never become an unthrottled one.
    const limiter = new RateLimiter(kbpsToBytesPerSec(0.001), clock);
    await limiter.consume(10);
    expect(clock.elapsed).toBeGreaterThan(0);
  });

  it('applies a new rate to subsequent reservations', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock);
    limiter.setRate(2000);
    await limiter.consume(1000);
    expect(clock.elapsed).toBe(500);
  });

  it('ignores zero-length reads', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock);
    await limiter.consume(0);
    expect(clock.elapsed).toBe(0);
  });
});

describe('THROTTLE_PRESETS', () => {
  it('exposes the six documented presets', () => {
    expect(Object.keys(THROTTLE_PRESETS).sort()).toEqual(
      ['3g', '4g', '56k', 'dsl', 'edge', 'wifi'].sort(),
    );
  });

  it('matches the spec values for 3g', () => {
    expect(THROTTLE_PRESETS['3g']).toEqual({ downKbps: 780, upKbps: 330, latencyMs: 100 });
  });
});

describe('Throttler', () => {
  it('is a no-op when disabled', async () => {
    const clock = fakeClock();
    const t = new Throttler({ enabled: false, downKbps: 780, upKbps: 330, latencyMs: 100 }, clock);
    await t.down.consume(10_000);
    await t.delayLatency();
    expect(clock.elapsed).toBe(0);
  });

  it('applies latency once when enabled', async () => {
    const clock = fakeClock();
    const t = new Throttler({ enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 }, clock);
    await t.delayLatency();
    expect(clock.elapsed).toBe(100);
  });

  it('reconfigures rates in place via update', async () => {
    const clock = fakeClock();
    const t = new Throttler({ enabled: true, downKbps: 8, upKbps: 8, latencyMs: 0 }, clock);
    t.update({ enabled: true, downKbps: 16, upKbps: 8, latencyMs: 0 });
    await t.down.consume(1000); // 16 kbps = 2000 B/s
    expect(clock.elapsed).toBe(500);
    expect(t.getSettings().downKbps).toBe(16);
  });
});
