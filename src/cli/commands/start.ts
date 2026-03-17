import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../server/config.js';
import { RoxyProxyServer } from '../../server/index.js';
import { printBanner, printStartInfo } from '../banner.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function registerStart(program: Command): void {
  program
    .command('start')
    .description('Start the proxy server')
    .option('--port <number>', 'Proxy port', '8080')
    .option('--ui-port <number>', 'UI/API port', '8081')
    .option('--db-path <path>', 'Database path')
    .action(async (opts) => {
      printBanner();

      const config = loadConfig({
        proxyPort: parseInt(opts.port, 10),
        uiPort: parseInt(opts.uiPort, 10),
        ...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
      });

      const pidPath = path.join(os.homedir(), '.roxyproxy', 'pid');
      fs.mkdirSync(path.dirname(pidPath), { recursive: true });
      fs.writeFileSync(pidPath, process.pid.toString());

      const server = new RoxyProxyServer(config);
      const { proxyPort, uiPort } = await server.start();

      printStartInfo(proxyPort, uiPort);

      const shutdown = async () => {
        console.log(`\n  ${pc.yellow('⏻')} ${pc.dim('Shutting down...')}`);
        await server.stop();
        try { fs.unlinkSync(pidPath); } catch {}
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
