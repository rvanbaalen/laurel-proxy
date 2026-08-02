import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigPath, loadConfig, saveThrottleSettings } from './config.js';
import { DEFAULT_THROTTLE } from '../shared/types.js';

describe('getConfigPath', () => {
  const originalEnv = process.env.LAUREL_PROXY_CONFIG;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LAUREL_PROXY_CONFIG;
    else process.env.LAUREL_PROXY_CONFIG = originalEnv;
  });

  it('defaults to ~/.laurel-proxy/config.json when unset', () => {
    delete process.env.LAUREL_PROXY_CONFIG;
    expect(getConfigPath()).toBe(path.join(os.homedir(), '.laurel-proxy', 'config.json'));
  });

  it('honours the LAUREL_PROXY_CONFIG override', () => {
    process.env.LAUREL_PROXY_CONFIG = '/tmp/some-test-config.json';
    expect(getConfigPath()).toBe('/tmp/some-test-config.json');
  });
});

describe('loadConfig throttle validation', () => {
  const originalEnv = process.env.LAUREL_PROXY_CONFIG;
  let tmpDir: string;

  /**
   * Writes a config file. A string is written verbatim, because some of the
   * values worth testing cannot survive `JSON.stringify` — it turns `Infinity`
   * into the token `null`, which is a different input with different (safe)
   * handling, so a test that went through it would pass while proving nothing
   * about the value it named.
   */
  function writeConfig(contents: unknown): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `laurel-config-load-${randomUUID()}-`));
    const configPath = path.join(tmpDir, 'config.json');
    process.env.LAUREL_PROXY_CONFIG = configPath;
    fs.writeFileSync(configPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LAUREL_PROXY_CONFIG;
    else process.env.LAUREL_PROXY_CONFIG = originalEnv;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps a valid throttle block', () => {
    writeConfig({ throttle: { enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 } });
    expect(loadConfig().throttle).toEqual({
      enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100,
    });
  });

  it('fills absent fields from the defaults rather than rejecting a partial block', () => {
    writeConfig({ throttle: { enabled: true, downKbps: 500 } });
    expect(loadConfig().throttle).toEqual({
      enabled: true, downKbps: 500, upKbps: 0, latencyMs: 0,
    });
  });

  it('refuses a non-numeric rate instead of reporting enabled while throttling nothing', () => {
    // The reason this matters, and the reason it is not merely cosmetic:
    // `kbpsToBytesPerSec(NaN)` returned NaN (its `<= 0` guard is false for NaN),
    // and `Math.ceil(NaN) > 0` is false too, so `RateLimiter` waited for nothing
    // on every chunk. Traffic passed at full speed while `GET /api/throttle` and
    // the UI pill both said "enabled" — a claim with no effect behind it.
    writeConfig({ throttle: { enabled: true, downKbps: 'fast', latencyMs: 100 } });
    const throttle = loadConfig().throttle;
    expect(throttle).toEqual(DEFAULT_THROTTLE);
    expect(throttle.enabled).toBe(false);
    expect(Number.isFinite(throttle.downKbps)).toBe(true);
  });

  it('refuses an overflowing numeric literal, which JSON.parse turns into Infinity', () => {
    // Written as raw text: `1e999` is valid JSON that parses to `Infinity`, and
    // it is the one way a hand-edited config file can smuggle a non-finite
    // number past a JSON parser. Round-tripping it through JSON.stringify would
    // quietly turn it into `null` and test something else entirely.
    writeConfig('{"throttle":{"enabled":true,"downKbps":1e999,"upKbps":10,"latencyMs":0}}');
    expect(loadConfig().throttle).toEqual(DEFAULT_THROTTLE);
  });

  it('refuses a non-boolean enabled, exactly like PUT /api/throttle does', () => {
    // `"false"` is a truthy string. This is the same input the REST endpoint was
    // fixed to reject; the config file accepted it and enabled throttling.
    writeConfig({ throttle: { enabled: 'false', downKbps: 500, upKbps: 500, latencyMs: 0 } });
    expect(loadConfig().throttle).toEqual(DEFAULT_THROTTLE);
  });

  it('refuses a negative rate', () => {
    writeConfig({ throttle: { enabled: true, downKbps: -5, upKbps: 0, latencyMs: 0 } });
    expect(loadConfig().throttle).toEqual(DEFAULT_THROTTLE);
  });

  it('refuses a throttle key that is not an object at all', () => {
    writeConfig({ throttle: '3g' });
    expect(loadConfig().throttle).toEqual(DEFAULT_THROTTLE);
  });

  it('leaves the default in place when the file has no throttle key', () => {
    writeConfig({ proxyPort: 9999 });
    const config = loadConfig();
    expect(config.proxyPort).toBe(9999);
    expect(config.throttle).toEqual(DEFAULT_THROTTLE);
  });
});

describe('saveThrottleSettings', () => {
  const originalEnv = process.env.LAUREL_PROXY_CONFIG;
  let tmpDir: string;
  let tmpConfigPath: string;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LAUREL_PROXY_CONFIG;
    else process.env.LAUREL_PROXY_CONFIG = originalEnv;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes throttle settings to the LAUREL_PROXY_CONFIG override, not the real config file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `laurel-config-test-${randomUUID()}-`));
    tmpConfigPath = path.join(tmpDir, 'config.json');
    process.env.LAUREL_PROXY_CONFIG = tmpConfigPath;

    const realConfigPath = path.join(os.homedir(), '.laurel-proxy', 'config.json');
    const realConfigExistedBefore = fs.existsSync(realConfigPath);
    const realConfigContentsBefore = realConfigExistedBefore
      ? fs.readFileSync(realConfigPath, 'utf-8')
      : null;

    const settings = { ...DEFAULT_THROTTLE, enabled: true, downKbps: 123 };
    saveThrottleSettings(settings);

    expect(fs.existsSync(tmpConfigPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(tmpConfigPath, 'utf-8'));
    expect(written.throttle).toEqual(settings);

    // The real developer config file must be untouched.
    if (realConfigExistedBefore) {
      expect(fs.readFileSync(realConfigPath, 'utf-8')).toBe(realConfigContentsBefore);
    } else {
      expect(fs.existsSync(realConfigPath)).toBe(false);
    }
  });

  it('preserves other keys already present in the config file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `laurel-config-test-${randomUUID()}-`));
    tmpConfigPath = path.join(tmpDir, 'config.json');
    process.env.LAUREL_PROXY_CONFIG = tmpConfigPath;
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ proxyPort: 9999 }));

    saveThrottleSettings({ ...DEFAULT_THROTTLE, enabled: true, latencyMs: 50 });

    const written = JSON.parse(fs.readFileSync(tmpConfigPath, 'utf-8'));
    expect(written.proxyPort).toBe(9999);
    expect(written.throttle.latencyMs).toBe(50);
  });
});
