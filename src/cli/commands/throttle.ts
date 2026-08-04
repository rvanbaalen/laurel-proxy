import type { Command } from 'commander';
import http from 'node:http';
import { formatThrottleSettings } from '../format.js';
import { THROTTLE_PRESETS } from '../../server/throttle.js';
import type { ThrottleSettings, ThrottleProfile } from '../../shared/types.js';

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Sends an HTTP request to the local proxy API and resolves with the
 * parsed JSON response. Exported so integration tests can drive it
 * against a real server.
 */
export function api(port: number, method: string, path: string, payload?: unknown): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 5000,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { error: text } });
          }
        });
      },
    );
    req.on('error', () => reject(new Error('Could not connect to proxy. Is it running?')));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Parses a --down/--up/--latency value into a finite number.
 *
 * Returns `undefined` when the option was never supplied, so callers can
 * distinguish "not set" from "set to 0" — both `opts.down` being unset and a
 * legitimate `--down 0` must be handled differently, and since Commander
 * hands us strings, an empty option value never reaches here (only literal
 * absence does; the string "0" is truthy and lands in the `Number()` branch
 * like any other value).
 *
 * Throws when the value doesn't parse to a finite number, rather than
 * letting `Number()` produce `NaN`. That distinction matters: `JSON.stringify`
 * silently turns `NaN` into `null`, and the PUT /api/throttle handler treats a
 * `null` field as "not provided" (via `??`), falling back to the current
 * setting. Left unchecked, a typo like `--down abc` would not error at all —
 * it would just quietly keep whatever the current downstream rate already
 * was, which is a confusing failure mode for a scriptable command.
 */
export function parseRateOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid ${label} value "${value}": expected a number.`);
  }
  return num;
}

/** Output formats accepted by `throttle`, matching the project-wide convention (see requests.ts). */
export const VALID_THROTTLE_FORMATS = ['json', 'table', 'agent'] as const;

/**
 * Reports a failure respecting --format: plain text on stderr for
 * humans, JSON on stdout for `--format json`/`agent` callers so
 * scripts get parseable output either way.
 */
function reportError(message: string, format: string): void {
  if (format === 'json' || format === 'agent') {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(message);
  }
}

/**
 * Registers the `throttle` command, which reads or updates the proxy's
 * bandwidth simulation over its local REST API.
 */
export function registerThrottle(program: Command): void {
  program
    .command('throttle [preset]')
    .description(`Simulate constrained network conditions (${Object.keys(THROTTLE_PRESETS).join(', ')}, off)`)
    .option('--down <kbps>', 'Downstream bandwidth in kbps')
    .option('--up <kbps>', 'Upstream bandwidth in kbps')
    .option('--latency <ms>', 'Added latency in milliseconds')
    .option('--status', 'Show current throttle settings')
    .option('--format <format>', 'Output format (json|table|agent)', 'table')
    .option('--ui-port <number>', 'UI/API port', '8081')
    .action(async (preset: string | undefined, opts) => {
      if (!(VALID_THROTTLE_FORMATS as readonly string[]).includes(opts.format)) {
        console.error(`Invalid format "${opts.format}". Valid formats: ${VALID_THROTTLE_FORMATS.join(', ')}`);
        process.exit(1);
        return;
      }

      const port = parseInt(opts.uiPort, 10);

      // A flag string like "0" is truthy, so `!opts.latency` is only true
      // when the flag was never supplied, not when it's literally 0.
      if (opts.status || (!preset && !opts.down && !opts.up && !opts.latency)) {
        try {
          const res = await api(port, 'GET', '/api/throttle');
          if (res.status !== 200) {
            reportError(String(res.body.error ?? 'Failed to read throttle settings'), opts.format);
            process.exit(1);
            return;
          }
          console.log(
            formatThrottleSettings(
              res.body.settings as ThrottleSettings,
              res.body.presets as Record<string, ThrottleProfile>,
              opts.format,
            ),
          );
        } catch (err) {
          reportError((err as Error).message, opts.format);
          process.exit(1);
        }
        return;
      }

      let payload: Record<string, unknown>;
      if (preset) {
        // A preset (including 'off') fully replaces settings server-side; any
        // --down/--up/--latency given alongside it are ignored.
        payload = { preset };
      } else {
        try {
          const downKbps = parseRateOption(opts.down, '--down');
          const upKbps = parseRateOption(opts.up, '--up');
          const latencyMs = parseRateOption(opts.latency, '--latency');
          payload = { enabled: true };
          if (downKbps !== undefined) payload.downKbps = downKbps;
          if (upKbps !== undefined) payload.upKbps = upKbps;
          if (latencyMs !== undefined) payload.latencyMs = latencyMs;
        } catch (err) {
          // Fail locally, before any network call: a bad number here must
          // not reach the server, where it would be silently discarded.
          reportError((err as Error).message, opts.format);
          process.exit(1);
          return;
        }
      }

      try {
        const res = await api(port, 'PUT', '/api/throttle', payload);
        if (res.status !== 200) {
          reportError(String(res.body.error ?? 'Failed to update throttle settings'), opts.format);
          process.exit(1);
          return;
        }
        console.log(
          formatThrottleSettings(
            res.body.settings as ThrottleSettings,
            THROTTLE_PRESETS,
            opts.format,
          ),
        );
      } catch (err) {
        reportError((err as Error).message, opts.format);
        process.exit(1);
      }
    });
}
