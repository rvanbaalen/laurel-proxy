import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LaurelProxyServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';
import { api } from '../../src/cli/commands/throttle.js';
import type { ThrottleSettings } from '../../src/shared/types.js';

// Exercises the CLI's HTTP transport (api()) against a real, in-process
// LaurelProxyServer on ephemeral ports — proving the round trip works
// against the actual router, not a mock. Formatter behaviour is covered by
// the pure unit tests in src/cli/format.test.ts; this test covers transport
// and wiring only. Never boots `laurel-proxy start` or touches the host's
// real system proxy settings.
describe('laurel-proxy throttle CLI transport', () => {
  let server: LaurelProxyServer;
  let uiPort: number;
  let tmpDir: string;
  let originalConfigEnv: string | undefined;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laurel-throttle-cli-'));

    // PUT /api/throttle persists to disk — redirect config I/O to a temp
    // file so this test never touches the developer's real
    // ~/.laurel-proxy/config.json.
    originalConfigEnv = process.env.LAUREL_PROXY_CONFIG;
    process.env.LAUREL_PROXY_CONFIG = path.join(tmpDir, 'config.json');

    const config = loadConfig({
      dbPath: path.join(tmpDir, `${randomUUID()}.db`),
      proxyPort: 0,
      uiPort: 0,
    });
    server = new LaurelProxyServer(config);
    const ports = await server.start();
    uiPort = ports.uiPort;
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalConfigEnv === undefined) delete process.env.LAUREL_PROXY_CONFIG;
    else process.env.LAUREL_PROXY_CONFIG = originalConfigEnv;
  });

  it('GET reports the default disabled state', async () => {
    const initial = await api(uiPort, 'GET', '/api/throttle');
    expect(initial.status).toBe(200);
    expect((initial.body.settings as ThrottleSettings).enabled).toBe(false);
    expect(initial.body.presets).toBeDefined();
  });

  it('PUT a preset, then confirm GET agrees — proves the transport works against the real router', async () => {
    const applied = await api(uiPort, 'PUT', '/api/throttle', { preset: '3g' });
    expect(applied.status).toBe(200);
    expect(applied.body.settings).toEqual({
      enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100,
    });

    const after = await api(uiPort, 'GET', '/api/throttle');
    expect((after.body.settings as ThrottleSettings).downKbps).toBe(780);
  });

  it('PUT explicit rate fields updates settings directly', async () => {
    const applied = await api(uiPort, 'PUT', '/api/throttle', {
      enabled: true,
      downKbps: 500,
      upKbps: 250,
      latencyMs: 10,
    });
    expect(applied.status).toBe(200);
    expect(applied.body.settings).toEqual({
      enabled: true, downKbps: 500, upKbps: 250, latencyMs: 10,
    });
  });

  it('PUT "off" preset disables throttling', async () => {
    const applied = await api(uiPort, 'PUT', '/api/throttle', { preset: 'off' });
    expect(applied.status).toBe(200);
    expect(applied.body.settings).toEqual({
      enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0,
    });
  });

  it('PUT with an unknown preset returns 400 listing valid presets', async () => {
    const res = await api(uiPort, 'PUT', '/api/throttle', { preset: 'nope' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('3g');
    expect(String(res.body.error)).toContain('off');
  });
});
