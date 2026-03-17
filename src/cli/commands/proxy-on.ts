import type { Command } from 'commander';
import pc from 'picocolors';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { printSuccess, printError, printInfo, printWarn } from '../banner.js';

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr });
    });
  });
}

async function getNetworkServices(): Promise<string[]> {
  const result = await run('networksetup', ['-listallnetworkservices']);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(line => line && !line.startsWith('An asterisk'));
}

export function registerProxyOn(program: Command): void {
  program
    .command('proxy-on')
    .description('Set RoxyProxy as system-wide proxy (macOS)')
    .option('--port <number>', 'Proxy port', '8080')
    .option('--service <name>', 'Network service name (default: auto-detect Wi-Fi)')
    .action(async (opts) => {
      if (os.platform() !== 'darwin') {
        printWarn('System proxy configuration is currently macOS-only.');
        printInfo('Set your HTTP/HTTPS proxy manually to 127.0.0.1:' + opts.port);
        return;
      }

      const port = opts.port;
      let service = opts.service;

      if (!service) {
        const services = await getNetworkServices();
        service = services.find(s => s === 'Wi-Fi') || services.find(s => s === 'Ethernet') || services[0];
        if (!service) {
          printError('No network services found.');
          process.exit(1);
        }
      }

      console.log('');
      printInfo(`Configuring proxy on ${pc.bold(service)}...`);

      const httpResult = await run('networksetup', ['-setwebproxy', service, '127.0.0.1', port]);
      const httpsResult = await run('networksetup', ['-setsecurewebproxy', service, '127.0.0.1', port]);

      if (httpResult.code === 0 && httpsResult.code === 0) {
        printSuccess(`System proxy set to ${pc.cyan(`127.0.0.1:${port}`)} on ${pc.bold(service)}`);
        console.log('');
        printInfo(`Run ${pc.cyan('roxyproxy proxy-off')} to disable.`);
      } else {
        printError('Failed to set system proxy. You may need to run with sudo.');
      }
      console.log('');
    });
}
