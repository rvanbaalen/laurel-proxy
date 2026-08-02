import { describe, it, expect } from 'vitest';
import { activePreset } from './client.ts';
import type { ThrottleState } from './client.ts';

const presets: ThrottleState['presets'] = {
  '56k': { downKbps: 56, upKbps: 33, latencyMs: 120 },
  edge: { downKbps: 240, upKbps: 200, latencyMs: 400 },
  '3g': { downKbps: 780, upKbps: 330, latencyMs: 100 },
  '4g': { downKbps: 4000, upKbps: 3000, latencyMs: 20 },
  dsl: { downKbps: 2000, upKbps: 256, latencyMs: 40 },
  wifi: { downKbps: 30000, upKbps: 15000, latencyMs: 5 },
};

function state(settings: ThrottleState['settings']): ThrottleState {
  return { settings, presets };
}

describe('activePreset', () => {
  it('returns "off" when throttling is disabled, even if values match a preset', () => {
    const s = state({ enabled: false, downKbps: 780, upKbps: 330, latencyMs: 100 });
    expect(activePreset(s)).toBe('off');
  });

  it('returns "unknown" when state is null (not yet loaded, or fetch failed)', () => {
    // This must NOT collapse into 'off' — an unloaded/failed fetch is not the
    // same claim as "throttling is confirmed disabled", and misreporting one
    // as the other is the same failure class the custom-vs-off case guards
    // against, just with 'unknown' in place of 'custom'.
    expect(activePreset(null)).toBe('unknown');
  });

  it('returns the matching preset key when enabled settings exactly match a preset', () => {
    const s = state({ enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 });
    expect(activePreset(s)).toBe('3g');
  });

  it('matches every documented preset exactly', () => {
    for (const [key, profile] of Object.entries(presets)) {
      const s = state({ enabled: true, ...profile });
      expect(activePreset(s)).toBe(key);
    }
  });

  it('returns "custom" when settings match no preset at all', () => {
    const s = state({ enabled: true, downKbps: 1234, upKbps: 999, latencyMs: 77 });
    expect(activePreset(s)).toBe('custom');
  });

  it('returns "custom" when settings partially match a preset (right downKbps, wrong latencyMs)', () => {
    // Naive implementations that only compare downKbps (or a subset of fields)
    // would wrongly report "3g" here.
    const s = state({ enabled: true, downKbps: 780, upKbps: 330, latencyMs: 999 });
    expect(activePreset(s)).toBe('custom');
  });

  it('returns "custom" when settings partially match a preset (right upKbps/latencyMs, wrong downKbps)', () => {
    const s = state({ enabled: true, downKbps: 1, upKbps: 330, latencyMs: 100 });
    expect(activePreset(s)).toBe('custom');
  });
});
