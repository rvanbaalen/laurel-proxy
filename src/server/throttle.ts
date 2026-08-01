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

export function kbpsToBytesPerSec(kbps: number): number {
  return Math.round((kbps * 1000) / 8);
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
