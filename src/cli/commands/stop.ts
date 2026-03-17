import type { Command } from 'commander';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { printSuccess, printError } from '../banner.js';

export function registerStop(program: Command): void {
  program
    .command('stop')
    .description('Stop the running proxy server')
    .option('--ui-port <number>', 'UI/API port', '8081')
    .action(async (opts) => {
      const port = parseInt(opts.uiPort, 10);

      try {
        await apiPost(port, '/api/shutdown');
        printSuccess('Server shutting down.');
        return;
      } catch {}

      const pidPath = path.join(os.homedir(), '.roxyproxy', 'pid');
      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 'SIGTERM');
          fs.unlinkSync(pidPath);
          printSuccess(`Sent SIGTERM to process ${pid}.`);
          return;
        } catch {}
      }

      printError('Could not stop proxy. Is it running?');
      process.exit(1);
    });
}

function apiPost(port: number, urlPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}
