import type { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { printSuccess, printError, printInfo, printWarn } from '../banner.js';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr });
    });
  });
}

export function registerTrustCa(program: Command): void {
  program
    .command('trust-ca')
    .description('Install and trust the CA certificate')
    .option('--no-interactive', 'Just print the cert path and instructions')
    .action(async (opts) => {
      const certPath = path.join(os.homedir(), '.roxyproxy', 'ca', 'ca.crt');

      if (!fs.existsSync(certPath)) {
        printError('CA certificate not found. Start the proxy first to generate it.');
        process.exit(1);
      }

      console.log('');
      printInfo(`CA Certificate: ${pc.cyan(certPath)}`);
      console.log('');

      const platform = os.platform();

      if (!opts.interactive) {
        printManualInstructions(certPath, platform);
        return;
      }

      if (platform === 'darwin') {
        await installMacOS(certPath);
      } else if (platform === 'linux') {
        await installLinux(certPath);
      } else {
        printWarn(`Automatic installation not supported on ${platform}.`);
        printManualInstructions(certPath, platform);
      }
    });
}

async function installMacOS(certPath: string): Promise<void> {
  console.log(`  This will add the RoxyProxy CA to your macOS system keychain.`);
  console.log(`  You'll be prompted for your ${pc.bold('sudo password')}.`);
  console.log('');

  const answer = await ask(`  ${pc.yellow('?')} Install certificate to system keychain? ${pc.dim('[Y/n]')} `);
  if (answer && answer !== 'y' && answer !== 'yes') {
    printInfo('Skipped. You can install manually:');
    printManualInstructions(certPath, 'darwin');
    return;
  }

  console.log('');
  printInfo('Installing certificate...');

  const result = await run('sudo', [
    'security', 'add-trusted-cert',
    '-d', '-r', 'trustRoot',
    '-k', '/Library/Keychains/System.keychain',
    certPath,
  ]);

  if (result.code === 0) {
    printSuccess('Certificate installed and trusted!');
    console.log('');
    printInfo('HTTPS interception is now active.');
    printInfo(`Test it: ${pc.cyan('curl -x http://127.0.0.1:8080 https://httpbin.org/get')}`);
  } else {
    printError('Failed to install certificate.');
    if (result.stderr) console.log(pc.dim(`  ${result.stderr.trim()}`));
    console.log('');
    printInfo('You can install manually:');
    printManualInstructions(certPath, 'darwin');
  }
  console.log('');
}

async function installLinux(certPath: string): Promise<void> {
  console.log(`  This will copy the RoxyProxy CA to your system certificate store.`);
  console.log(`  You'll be prompted for your ${pc.bold('sudo password')}.`);
  console.log('');

  const answer = await ask(`  ${pc.yellow('?')} Install certificate to system store? ${pc.dim('[Y/n]')} `);
  if (answer && answer !== 'y' && answer !== 'yes') {
    printInfo('Skipped. You can install manually:');
    printManualInstructions(certPath, 'linux');
    return;
  }

  console.log('');
  printInfo('Installing certificate...');

  const copyResult = await run('sudo', [
    'cp', certPath, '/usr/local/share/ca-certificates/roxyproxy.crt',
  ]);

  if (copyResult.code !== 0) {
    printError('Failed to copy certificate.');
    return;
  }

  const updateResult = await run('sudo', ['update-ca-certificates']);

  if (updateResult.code === 0) {
    printSuccess('Certificate installed and trusted!');
  } else {
    printError('Failed to update certificate store.');
    if (updateResult.stderr) console.log(pc.dim(`  ${updateResult.stderr.trim()}`));
  }
  console.log('');
}

function printManualInstructions(certPath: string, platform: string): void {
  if (platform === 'darwin') {
    console.log(`  ${pc.bold('macOS:')}`);
    console.log(pc.cyan(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`));
  } else {
    console.log(`  ${pc.bold('Linux (Debian/Ubuntu):')}`);
    console.log(pc.cyan(`  sudo cp "${certPath}" /usr/local/share/ca-certificates/roxyproxy.crt`));
    console.log(pc.cyan(`  sudo update-ca-certificates`));
  }
  console.log('');
  console.log(`  ${pc.bold('Firefox')} ${pc.dim('(uses its own cert store):')}`);
  console.log(`  Settings > Privacy & Security > Certificates > Import`);
  console.log('');
}
