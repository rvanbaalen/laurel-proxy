import pc from 'picocolors';
import os from 'node:os';

export function getLocalHostname(): string {
  return os.hostname();
}

export function printBanner(): void {
  console.log('');
  console.log(pc.cyan('  ___                ___                    '));
  console.log(pc.cyan(' | _ \\___ __ ___  _ | _ \\_ _ _____ ___  _  '));
  console.log(pc.cyan(' |   / _ \\\\ \\ / || || ___/ \'_/ _ \\ \\ /| || |'));
  console.log(pc.cyan(' |_|_\\___//_\\_\\\\_, ||_|  |_| \\___/_\\_\\ \\_, |'));
  console.log(pc.cyan('                |__/                   |__/ '));
  console.log('');
}

export function printStartInfo(proxyPort: number, uiPort: number): void {
  const hostname = getLocalHostname();
  console.log(`  ${pc.green('●')} Proxy    ${pc.cyan(`http://127.0.0.1:${proxyPort}`)}`);
  console.log(`  ${pc.green('●')} Web UI   ${pc.cyan(`http://127.0.0.1:${uiPort}`)}`);
  console.log(`  ${pc.green('●')} Network  ${pc.cyan(`http://${hostname}:${uiPort}`)}`);
  console.log('');
  console.log(pc.dim('  Ctrl+C to stop'));
  console.log('');
}

export function printSuccess(msg: string): void {
  console.log(`  ${pc.green('✔')} ${msg}`);
}

export function printError(msg: string): void {
  console.log(`  ${pc.red('✖')} ${msg}`);
}

export function printInfo(msg: string): void {
  console.log(`  ${pc.cyan('›')} ${msg}`);
}

export function printWarn(msg: string): void {
  console.log(`  ${pc.yellow('!')} ${msg}`);
}
