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

export function registerProxyOff(program: Command): void {
  program
    .command('proxy-off')
    .description('Remove RoxyProxy as system-wide proxy (macOS)')
    .option('--service <name>', 'Network service name (default: auto-detect Wi-Fi)')
    .action(async (opts) => {
      if (os.platform() !== 'darwin') {
        printWarn('System proxy configuration is currently macOS-only.');
        printInfo('Remove your HTTP/HTTPS proxy settings manually.');
        return;
      }

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
      printInfo(`Disabling proxy on ${pc.bold(service)}...`);

      const httpResult = await run('networksetup', ['-setwebproxystate', service, 'off']);
      const httpsResult = await run('networksetup', ['-setsecurewebproxystate', service, 'off']);

      if (httpResult.code === 0 && httpsResult.code === 0) {
        printSuccess(`System proxy disabled on ${pc.bold(service)}`);
      } else {
        printError('Failed to disable system proxy.');
      }
      console.log('');
    });
}
