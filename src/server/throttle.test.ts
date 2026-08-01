import { describe, it, expect } from 'vitest';
import { RateLimiter, Throttler, THROTTLE_PRESETS, kbpsToBytesPerSec } from './throttle.js';
import type { Clock } from './throttle.js';

/** Deterministic clock: sleep advances virtual time instantly. */
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

  it('serialises concurrent consumers onto one shared pipe', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock);
    await limiter.consume(500);
    await limiter.consume(500);
    // Two 500-byte reservations on a 1000 B/s link total 1 second.
    expect(clock.elapsed).toBe(1000);
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
