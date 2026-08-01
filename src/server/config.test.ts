import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigPath, saveThrottleSettings } from './config.js';
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
