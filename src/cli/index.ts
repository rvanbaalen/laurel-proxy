#!/usr/bin/env node
import { Command } from 'commander';
import { registerStart } from './commands/start.js';
import { registerStop } from './commands/stop.js';
import { registerStatus } from './commands/status.js';
import { registerRequests } from './commands/requests.js';
import { registerRequest } from './commands/request.js';
import { registerClear } from './commands/clear.js';
import { registerTrustCa } from './commands/trust-ca.js';
import { registerUninstallCa } from './commands/uninstall-ca.js';
import { registerProxyOn } from './commands/proxy-on.js';
import { registerProxyOff } from './commands/proxy-off.js';

const program = new Command();
program
  .name('roxyproxy')
  .description('HTTP/HTTPS intercepting proxy with CLI and web UI')
  .version('0.1.0');

// Interactive mode (default when no command given)
program
  .command('interactive', { isDefault: true })
  .description('Launch interactive menu')
  .action(async () => {
    const { launchInteractive } = await import('./interactive.js');
    await launchInteractive();
  });

registerStart(program);
registerStop(program);
registerStatus(program);
registerRequests(program);
registerRequest(program);
registerClear(program);
registerTrustCa(program);
registerUninstallCa(program);
registerProxyOn(program);
registerProxyOff(program);

program.parse();
