import type { Command } from 'commander';
import http from 'node:http';
import { printSuccess, printError } from '../banner.js';

export function registerClear(program: Command): void {
  program
    .command('clear')
    .description('Clear all captured traffic')
    .option('--ui-port <number>', 'UI/API port', '8081')
    .action(async (opts) => {
      const port = parseInt(opts.uiPort, 10);
      try {
        await apiDelete(port, '/api/requests');
        printSuccess('All traffic cleared.');
      } catch {
        printError('Could not clear. Is the proxy running?');
        process.exit(1);
      }
    });
}

function apiDelete(port: number, urlPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'DELETE' }, (res) => {
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
