import os from 'node:os';
import { execFile } from 'node:child_process';

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

async function detectService(preferred?: string): Promise<string | null> {
  if (preferred) return preferred;
  const services = await getNetworkServices();
  return services.find(s => s === 'Wi-Fi') || services.find(s => s === 'Ethernet') || services[0] || null;
}

export interface ProxyResult {
  ok: boolean;
  message: string;
}

export async function enableSystemProxy(port = '8080', service?: string): Promise<ProxyResult> {
  if (os.platform() !== 'darwin') {
    return { ok: false, message: 'System proxy configuration is currently macOS-only.' };
  }

  const svc = await detectService(service);
  if (!svc) {
    return { ok: false, message: 'No network services found.' };
  }

  const httpResult = await run('networksetup', ['-setwebproxy', svc, '127.0.0.1', port]);
  const httpsResult = await run('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', port]);

  if (httpResult.code === 0 && httpsResult.code === 0) {
    return { ok: true, message: `System proxy set to 127.0.0.1:${port} on ${svc}` };
  }
  return { ok: false, message: 'Failed to set system proxy. You may need to run with sudo.' };
}

export async function disableSystemProxy(service?: string): Promise<ProxyResult> {
  if (os.platform() !== 'darwin') {
    return { ok: false, message: 'System proxy configuration is currently macOS-only.' };
  }

  const svc = await detectService(service);
  if (!svc) {
    return { ok: false, message: 'No network services found.' };
  }

  const httpResult = await run('networksetup', ['-setwebproxystate', svc, 'off']);
  const httpsResult = await run('networksetup', ['-setsecurewebproxystate', svc, 'off']);

  if (httpResult.code === 0 && httpsResult.code === 0) {
    return { ok: true, message: `System proxy disabled on ${svc}` };
  }
  return { ok: false, message: 'Failed to disable system proxy.' };
}

export interface CaStatus {
  exists: boolean;
  trusted: boolean;
  certPath: string;
}

export async function checkCaStatus(): Promise<CaStatus> {
  const certPath = `${os.homedir()}/.roxyproxy/ca/ca.crt`;
  const { existsSync } = await import('node:fs');

  if (!existsSync(certPath)) {
    return { exists: false, trusted: false, certPath };
  }

  if (os.platform() === 'darwin') {
    const result = await run('security', ['verify-cert', '-c', certPath]);
    return { exists: true, trusted: result.code === 0, certPath };
  }

  if (os.platform() === 'linux') {
    const { existsSync: exists2 } = await import('node:fs');
    const trusted = exists2('/usr/local/share/ca-certificates/roxyproxy.crt');
    return { exists: true, trusted, certPath };
  }

  return { exists: true, trusted: false, certPath };
}

export async function installCaCert(): Promise<ProxyResult> {
  const fs = await import('node:fs');
  const certPath = `${os.homedir()}/.roxyproxy/ca/ca.crt`;
  if (!fs.existsSync(certPath)) {
    return { ok: false, message: 'CA certificate not found. Start the proxy first.' };
  }

  if (os.platform() === 'darwin') {
    const result = await run('sudo', [
      'security', 'add-trusted-cert',
      '-d', '-r', 'trustRoot',
      '-k', '/Library/Keychains/System.keychain',
      certPath,
    ]);
    if (result.code === 0) {
      return { ok: true, message: 'Certificate installed and trusted!' };
    }
    return { ok: false, message: 'Failed to install certificate. Check sudo permissions.' };
  }

  if (os.platform() === 'linux') {
    const copy = await run('sudo', ['cp', certPath, '/usr/local/share/ca-certificates/roxyproxy.crt']);
    if (copy.code !== 0) return { ok: false, message: 'Failed to copy certificate.' };
    const update = await run('sudo', ['update-ca-certificates']);
    if (update.code === 0) {
      return { ok: true, message: 'Certificate installed and trusted!' };
    }
    return { ok: false, message: 'Failed to update certificate store.' };
  }

  return { ok: false, message: `Automatic install not supported on ${os.platform()}.` };
}
