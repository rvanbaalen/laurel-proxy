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
 * Single validation gate for throttle settings from an untrusted source — the
 * PUT endpoint body or the config file — so both surfaces enforce identical
 * rules; absent fields fall back to the current setting.
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
    // Number.isFinite rejects NaN, Infinity, and numeric strings like "500" —
    // accepting those here would let this surface disagree with the other again.
    if (!Number.isFinite(value) || (value as number) < 0) {
      return { error: `${key} must be a non-negative number` };
    }
    rates[key] = value as number;
  }

  return { settings: { enabled, ...rates } };
}

/**
 * Converts a kbps rate to bytes/sec for RateLimiter, treating non-finite or
 * non-positive input as unthrottled and clamps valid rates to at least 1.
 */
export function kbpsToBytesPerSec(kbps: number): number {
  // NaN fails <= 0 but Math.ceil(NaN) > 0 is also false, so an unvalidated NaN
  // rate would silently disable throttling instead of erroring.
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  // Clamps to 1 B/s minimum: RateLimiter treats 0 as unlimited, so rounding a
  // slow-but-nonzero rate down to 0 would remove throttling entirely.
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

/**
 * Applies configured bandwidth and latency limits to one HTTP exchange, via
 * one RateLimiter per direction plus a fixed per-request delay.
 */
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
