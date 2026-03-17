import type { Command } from 'commander';
import pc from 'picocolors';
import http from 'node:http';
import { printError } from '../banner.js';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show proxy status')
    .option('--ui-port <number>', 'UI/API port', '8081')
    .action(async (opts) => {
      const port = parseInt(opts.uiPort, 10);
      try {
        const body = await apiGet(port, '/api/status');
        const s = JSON.parse(body);

        const dot = s.running ? pc.green('●') : pc.red('●');
        const state = s.running ? pc.green('Running') : pc.red('Stopped');
        const bytes = s.dbSizeBytes;
        const size = bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)}KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

        console.log('');
        console.log(`  ${dot} ${pc.bold('Status')}     ${state}`);
        console.log(`    ${pc.dim('Proxy')}      port ${pc.cyan(String(s.proxyPort))}`);
        console.log(`    ${pc.dim('Requests')}   ${pc.bold(String(s.requestCount))}`);
        console.log(`    ${pc.dim('DB Size')}    ${size}`);
        console.log('');
      } catch {
        printError('Proxy is not running.');
        process.exit(1);
      }
    });
}

function apiGet(port: number, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}
