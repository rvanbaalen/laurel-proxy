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

export function registerUntrustCa(program: Command): void {
  program
    .command('untrust-ca')
    .description('Remove the CA certificate from the system trust store')
    .option('--no-interactive', 'Just print instructions without prompting')
    .action(async (opts) => {
      const certPath = path.join(os.homedir(), '.roxyproxy', 'ca', 'ca.crt');

      if (!fs.existsSync(certPath)) {
        printError('CA certificate not found. Nothing to remove.');
        process.exit(1);
      }

      const platform = os.platform();

      if (!opts.interactive) {
        printManualInstructions(certPath, platform);
        return;
      }

      if (platform === 'darwin') {
        await uninstallMacOS(certPath);
      } else if (platform === 'linux') {
        await uninstallLinux();
      } else {
        printWarn(`Automatic removal not supported on ${platform}.`);
        printManualInstructions(certPath, platform);
      }
    });
}

async function uninstallMacOS(certPath: string): Promise<void> {
  // Check if the cert is actually in the keychain
  const verifyResult = await run('security', ['verify-cert', '-c', certPath]);
  if (verifyResult.code !== 0) {
    printInfo('Certificate is not currently trusted in the system keychain.');
    return;
  }

  console.log('');
  console.log(`  This will remove the RoxyProxy CA from your macOS system keychain.`);
  console.log(`  You'll be prompted for your ${pc.bold('sudo password')}.`);
  console.log('');

  const answer = await ask(`  ${pc.yellow('?')} Remove certificate from system keychain? ${pc.dim('[Y/n]')} `);
  if (answer && answer !== 'y' && answer !== 'yes') {
    printInfo('Skipped.');
    return;
  }

  console.log('');
  printInfo('Removing certificate...');

  const result = await run('sudo', [
    'security', 'remove-trusted-cert',
    '-d', certPath,
  ]);

  if (result.code === 0) {
    printSuccess('Certificate removed from system trust store.');
  } else {
    printError('Failed to remove certificate.');
    if (result.stderr) console.log(pc.dim(`  ${result.stderr.trim()}`));
    console.log('');
    printInfo('You can remove it manually:');
    printManualInstructions(certPath, 'darwin');
  }
  console.log('');
}

async function uninstallLinux(): Promise<void> {
  const targetPath = '/usr/local/share/ca-certificates/roxyproxy.crt';
  const { existsSync } = await import('node:fs');

  if (!existsSync(targetPath)) {
    printInfo('Certificate is not currently installed in the system store.');
    return;
  }

  console.log('');
  console.log(`  This will remove the RoxyProxy CA from your system certificate store.`);
  console.log(`  You'll be prompted for your ${pc.bold('sudo password')}.`);
  console.log('');

  const answer = await ask(`  ${pc.yellow('?')} Remove certificate from system store? ${pc.dim('[Y/n]')} `);
  if (answer && answer !== 'y' && answer !== 'yes') {
    printInfo('Skipped.');
    return;
  }

  console.log('');
  printInfo('Removing certificate...');

  const rmResult = await run('sudo', ['rm', '-f', targetPath]);
  if (rmResult.code !== 0) {
    printError('Failed to remove certificate file.');
    return;
  }

  const updateResult = await run('sudo', ['update-ca-certificates', '--fresh']);
  if (updateResult.code === 0) {
    printSuccess('Certificate removed from system trust store.');
  } else {
    printError('Failed to update certificate store.');
    if (updateResult.stderr) console.log(pc.dim(`  ${updateResult.stderr.trim()}`));
  }
  console.log('');
}

function printManualInstructions(certPath: string, platform: string): void {
  console.log('');
  if (platform === 'darwin') {
    console.log(`  ${pc.bold('macOS:')}`);
    console.log(pc.cyan(`  sudo security remove-trusted-cert -d "${certPath}"`));
  } else {
    console.log(`  ${pc.bold('Linux (Debian/Ubuntu):')}`);
    console.log(pc.cyan(`  sudo rm /usr/local/share/ca-certificates/roxyproxy.crt`));
    console.log(pc.cyan(`  sudo update-ca-certificates --fresh`));
  }
  console.log('');
  console.log(`  ${pc.bold('Firefox')} ${pc.dim('(uses its own cert store):')}`);
  console.log(`  Settings > Privacy & Security > Certificates > View Certificates > Delete "RoxyProxy CA"`);
  console.log('');
}
