import type { Command } from 'commander';
import pc from 'picocolors';
import readline from 'node:readline';
import { loadConfig } from '../../server/config.js';
import { RoxyProxyServer } from '../../server/index.js';
import { findExistingInstances, killInstance } from '../../server/port-utils.js';
import { printBanner, printStartInfo, printWarn, printError, printSuccess } from '../banner.js';
import { enableSystemProxy, disableSystemProxy, checkSystemProxyStatus } from '../system-proxy.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

function formatInstance(inst: { pid: number; ports: number[] }): string {
  const portInfo = inst.ports.length > 0 ? ` on port${inst.ports.length > 1 ? 's' : ''} ${inst.ports.join(', ')}` : '';
  return `PID ${inst.pid}${portInfo}`;
}

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

      // Check for existing instances
      const existing = await findExistingInstances(config.proxyPort, config.uiPort);
      if (existing.length > 0) {
        for (const inst of existing) {
          printWarn(`Existing RoxyProxy instance detected: ${formatInstance(inst)}`);
        }

        const isTTY = process.stdin.isTTY;
        const shouldKill = isTTY
          ? await confirm(`  ${pc.yellow('?')} Kill existing instance${existing.length > 1 ? 's' : ''} and continue? (y/N) `)
          : true;

        if (!shouldKill) {
          printError('Aborted.');
          process.exit(1);
        }

        for (const inst of existing) {
          const killed = await killInstance(inst);
          if (killed) {
            printSuccess(`Stopped instance ${formatInstance(inst)}`);
          } else {
            printError(`Failed to stop instance ${formatInstance(inst)}`);
            process.exit(1);
          }
        }
        console.log('');
      }

      const pidPath = path.join(os.homedir(), '.roxyproxy', 'pid');
      fs.mkdirSync(path.dirname(pidPath), { recursive: true });
      fs.writeFileSync(pidPath, process.pid.toString());

      const server = new RoxyProxyServer(config);
      const { proxyPort, uiPort } = await server.start();

      printStartInfo(proxyPort, uiPort);

      const pidCleanup = () => { try { fs.unlinkSync(pidPath); } catch {} };

      const shutdown = async () => {
        console.log(`\n  ${pc.yellow('⏻')} ${pc.dim('Shutting down...')}`);
        if (process.stdin.isRaw) process.stdin.setRawMode(false);
        await server.stop();
        pidCleanup();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Interactive controls (only if TTY)
      if (process.stdin.isTTY) {
        let systemProxyEnabled = await checkSystemProxyStatus();
        let linesWritten = 0;

        const clearControls = () => {
          for (let i = 0; i < linesWritten; i++) {
            process.stdout.write('\x1B[A\x1B[2K');
          }
          linesWritten = 0;
        };

        const printControls = (statusMsg?: string) => {
          clearControls();
          const lines: string[] = [];
          if (statusMsg) {
            lines.push(`  ${statusMsg}`);
          }
          lines.push('');
          const proxyLabel = systemProxyEnabled
            ? `${pc.green('[enabled]')} Disable system proxy`
            : `${pc.dim('[disabled]')} Enable system proxy`;
          lines.push(`  ${pc.cyan('p')}  ${proxyLabel}`);
          lines.push(`  ${pc.cyan('m')}  Open main menu`);
          lines.push(`  ${pc.cyan('q')}  Quit`);
          for (const line of lines) {
            console.log(line);
          }
          linesWritten = lines.length;
        };

        printControls();

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', async (data) => {
          const key = data.toString();

          if (key === 'q' || key === '\x03') { // q or Ctrl+C
            await shutdown();
            return;
          }

          if (key === 'p') {
            let msg: string;
            if (systemProxyEnabled) {
              const result = await disableSystemProxy();
              msg = `${result.ok ? pc.green('✓') : pc.red('✗')} ${result.message}`;
              if (result.ok) systemProxyEnabled = false;
            } else {
              const result = await enableSystemProxy();
              msg = `${result.ok ? pc.green('✓') : pc.red('✗')} ${result.message}`;
              if (result.ok) systemProxyEnabled = true;
            }
            printControls(msg);
          }

          if (key === 'm') {
            // Stop raw mode, stop server, and launch interactive menu
            process.stdin.setRawMode(false);
            process.stdin.pause();
            await server.stop();
            pidCleanup();
            const { launchInteractive } = await import('../interactive.js');
            await launchInteractive();
          }
        });
      }
    });
}
