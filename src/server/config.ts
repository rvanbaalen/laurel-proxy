import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config, ThrottleSettings } from '../shared/types.js';
import { DEFAULT_CONFIG } from '../shared/types.js';

function expandHome(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Resolve the config file location. Honours LAUREL_PROXY_CONFIG so tests (and
 * later, the REST endpoint that persists throttle settings) can redirect
 * config I/O to a temp file instead of touching the developer's real
 * ~/.laurel-proxy/config.json.
 */
export function getConfigPath(): string {
  return expandHome(process.env.LAUREL_PROXY_CONFIG ?? '~/.laurel-proxy/config.json');
}

function parseSize(value: string): number {
  const match = value.match(/^(\d+)\s*(MB|GB|KB|B)?$/i);
  if (!match) return parseInt(value, 10);
  const num = parseInt(match[1], 10);
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024,
  };
  return num * (multipliers[unit] || 1);
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return parseInt(value, 10);
  const num = parseInt(match[1], 10);
  const unit = (match[2] || 'ms').toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000,
  };
  return num * (multipliers[unit] || 1);
}

export function loadConfig(cliFlags: Partial<Config> = {}): Config {
  let fileConfig: Partial<Config> = {};

  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      fileConfig = {
        proxyPort: raw.proxyPort,
        uiPort: raw.uiPort,
        dbPath: raw.dbPath,
        maxAge: typeof raw.maxAge === 'string' ? parseDuration(raw.maxAge) : raw.maxAge,
        maxDbSize: typeof raw.maxDbSize === 'string' ? parseSize(raw.maxDbSize) : raw.maxDbSize,
        maxBodySize: typeof raw.maxBodySize === 'string' ? parseSize(raw.maxBodySize) : raw.maxBodySize,
        certCacheSize: raw.certCacheSize,
        throttle: raw.throttle,
      };
      for (const key of Object.keys(fileConfig) as (keyof Config)[]) {
        if (fileConfig[key] === undefined) delete fileConfig[key];
      }
    } catch {
      // Ignore invalid config file
    }
  }

  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...cliFlags,
  };

  merged.dbPath = expandHome(merged.dbPath);

  return merged;
}

/** Persist throttle settings back to the config file, preserving other keys. */
export function saveThrottleSettings(settings: ThrottleSettings): void {
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      raw = {};
    }
  }
  raw.throttle = settings;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
}

export { expandHome, parseSize, parseDuration };
