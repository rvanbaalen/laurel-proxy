import type { ThrottleProfile, ThrottleSettings } from '../shared/types.js';
import { DEFAULT_THROTTLE } from '../shared/types.js';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A candidate settings object from any untrusted surface: request body or config file. */
export interface ThrottleSettingsInput {
  enabled?: unknown;
  downKbps?: unknown;
  upKbps?: unknown;
  latencyMs?: unknown;
}

/**
 * The one place throttle settings coming from outside the process are checked.
 *
 * Both `PUT /api/throttle` and the config file feed the same live `Throttler`,
 * and only the endpoint used to validate. The config file — a documented,
 * user-facing surface — copied its `throttle` block through untouched, so
 * `{"enabled": true, "downKbps": null}` (`null` coerces to 0 in arithmetic but
 * survives `?? current`) or a hand-written `NaN`-producing value reached
 * `kbpsToBytesPerSec`, whose `<= 0` guard is false for NaN. `Math.ceil(NaN) > 0`
 * is also false, so `RateLimiter` short-circuited: traffic completely
 * unthrottled while `GET /api/throttle` and the UI pill both reported enabled.
 *
 * Shared rather than reimplemented on purpose. A second copy of this logic is
 * exactly how the two surfaces came to disagree, and a second copy is what a
 * future change would have to remember to update twice.
 *
 * Absent fields fall back rather than failing: that is the endpoint's documented
 * merge semantics ("omitted fields fall back to the current setting"), and the
 * loader passes `DEFAULT_THROTTLE` as the fallback so a partial config block
 * means the same thing.
 */
export function validateThrottleSettings(
  input: ThrottleSettingsInput,
  fallback: ThrottleSettings,
): { settings: ThrottleSettings } | { error: string } {
  const enabled = input.enabled ?? fallback.enabled;
  if (typeof enabled !== 'boolean') {
    return { error: 'enabled must be a boolean' };
  }

  const rates: Record<'downKbps' | 'upKbps' | 'latencyMs', number> = {
    downKbps: 0, upKbps: 0, latencyMs: 0,
  };
  for (const key of ['downKbps', 'upKbps', 'latencyMs'] as const) {
    const value = input[key] ?? fallback[key];
    // `Number.isFinite` rejects NaN, ±Infinity, and every non-number (a numeric
    // string included — "500" is a typo, not a rate, and accepting it here would
    // make the two surfaces disagree again).
    if (!Number.isFinite(value) || (value as number) < 0) {
      return { error: `${key} must be a non-negative number` };
    }
    rates[key] = value as number;
  }

  return { settings: { enabled, ...rates } };
}

export function kbpsToBytesPerSec(kbps: number): number {
  // `!Number.isFinite` rather than `<= 0` alone: NaN fails every comparison, so
  // a NaN rate would return NaN, and `Math.ceil(NaN) > 0` is false — the limiter
  // would then wait for nothing on every chunk, i.e. no throttling at all while
  // the settings say otherwise. Validation should keep NaN out; this makes the
  // failure mode a disabled limiter rather than a lying one if it ever gets in.
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  // Clamp to at least 1 B/s. RateLimiter treats 0 as "unlimited", so rounding a
  // small-but-nonzero rate down to 0 would turn a very slow link into an
  // unthrottled one — the exact opposite of what was configured.
  return Math.max(1, Math.round((kbps * 1000) / 8));
}

/**
 * Models one shared bandwidth-limited link. Each consume() reserves the time
 * slice needed to transmit `bytes` and waits for it, so concurrent callers
 * queue behind one another rather than each receiving the full rate.
 */
export class RateLimiter {
  private nextFreeAt = 0;

  constructor(
    private bytesPerSec: number,
    private clock: Clock = realClock,
  ) {}

  setRate(bytesPerSec: number): void {
    this.bytesPerSec = bytesPerSec;
  }

  async consume(bytes: number): Promise<void> {
    if (this.bytesPerSec <= 0 || bytes <= 0) return;
    const now = this.clock.now();
    // An idle link resets to now, so pauses do not bank credit.
    const startAt = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = startAt + (bytes / this.bytesPerSec) * 1000;
    const waitMs = Math.ceil(this.nextFreeAt - now);
    if (waitMs > 0) await this.clock.sleep(waitMs);
  }
}

export const THROTTLE_PRESETS: Record<string, ThrottleProfile> = {
  '56k': { downKbps: 56, upKbps: 33, latencyMs: 120 },
  edge: { downKbps: 240, upKbps: 200, latencyMs: 400 },
  '3g': { downKbps: 780, upKbps: 330, latencyMs: 100 },
  '4g': { downKbps: 4000, upKbps: 3000, latencyMs: 20 },
  dsl: { downKbps: 2000, upKbps: 256, latencyMs: 40 },
  wifi: { downKbps: 30000, upKbps: 15000, latencyMs: 5 },
};

export class Throttler {
  readonly down: RateLimiter;
  readonly up: RateLimiter;
  private settings: ThrottleSettings;

  constructor(
    settings: ThrottleSettings = DEFAULT_THROTTLE,
    private clock: Clock = realClock,
  ) {
    this.settings = settings;
    this.down = new RateLimiter(this.rate(settings.downKbps, settings.enabled), clock);
    this.up = new RateLimiter(this.rate(settings.upKbps, settings.enabled), clock);
  }

  private rate(kbps: number, enabled: boolean): number {
    return enabled && kbps > 0 ? kbpsToBytesPerSec(kbps) : 0;
  }

  getSettings(): ThrottleSettings {
    return { ...this.settings };
  }

  update(settings: ThrottleSettings): void {
    this.settings = settings;
    this.down.setRate(this.rate(settings.downKbps, settings.enabled));
    this.up.setRate(this.rate(settings.upKbps, settings.enabled));
  }

  /** Injected once per HTTP exchange, before the first response byte. */
  async delayLatency(): Promise<void> {
    if (!this.settings.enabled || this.settings.latencyMs <= 0) return;
    await this.clock.sleep(this.settings.latencyMs);
  }
}
