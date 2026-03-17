import pc from 'picocolors';

const BANNER = `
  ${pc.magenta('╦═╗')}${pc.cyan('╔═╗')}${pc.green('═╗╔═')}${pc.yellow('╦ ╦')}${pc.red('╔═╗')}${pc.blue('╦═╗')}${pc.magenta('╔═╗')}${pc.cyan('═╗╔═')}${pc.green('╦ ╦')}
  ${pc.magenta('╠╦╝')}${pc.cyan('║ ║')}${pc.green(' ╠╣ ')}${pc.yellow('╚╦╝')}${pc.red('╠═╝')}${pc.blue('╠╦╝')}${pc.magenta('║ ║')}${pc.cyan(' ╠╣ ')}${pc.green('╚╦╝')}
  ${pc.magenta('╩╚═')}${pc.cyan('╚═╝')}${pc.green('═╝╚═')}${pc.yellow(' ╩ ')}${pc.red('╩  ')}${pc.blue('╩╚═')}${pc.magenta('╚═╝')}${pc.cyan('═╝╚═')}${pc.green(' ╩ ')}
`;

export function printBanner(): void {
  console.log(BANNER);
  console.log(pc.dim('  HTTP/HTTPS intercepting proxy'));
  console.log('');
}

export function printStartInfo(proxyPort: number, uiPort: number): void {
  console.log(`  ${pc.green('●')} ${pc.bold('Proxy')}    ${pc.cyan(`http://127.0.0.1:${proxyPort}`)}`);
  console.log(`  ${pc.green('●')} ${pc.bold('Web UI')}   ${pc.cyan(`http://127.0.0.1:${uiPort}`)}`);
  console.log('');
  console.log(pc.dim('  Press Ctrl+C to stop'));
  console.log('');
}

export function printSuccess(msg: string): void {
  console.log(`  ${pc.green('✔')} ${msg}`);
}

export function printError(msg: string): void {
  console.log(`  ${pc.red('✖')} ${msg}`);
}

export function printInfo(msg: string): void {
  console.log(`  ${pc.blue('ℹ')} ${msg}`);
}

export function printWarn(msg: string): void {
  console.log(`  ${pc.yellow('⚠')} ${msg}`);
}
