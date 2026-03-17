#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { registerStart } from './commands/start.js';
import { registerStop } from './commands/stop.js';
import { registerStatus } from './commands/status.js';
import { registerRequests } from './commands/requests.js';
import { registerRequest } from './commands/request.js';
import { registerClear } from './commands/clear.js';
import { registerTrustCa } from './commands/trust-ca.js';
import { registerProxyOn } from './commands/proxy-on.js';
import { registerProxyOff } from './commands/proxy-off.js';

const program = new Command();
program
  .name('roxyproxy')
  .description(pc.dim('HTTP/HTTPS intercepting proxy with CLI and web UI'))
  .version('0.1.0');

registerStart(program);
registerStop(program);
registerStatus(program);
registerRequests(program);
registerRequest(program);
registerClear(program);
registerTrustCa(program);
registerProxyOn(program);
registerProxyOff(program);

program.parse();
