import forge from 'node-forge';
import fs from 'node:fs';
import path from 'node:path';

interface CertKeyPair {
  cert: string;
  key: string;
}

export class CertificateAuthority {
  private caCert: forge.pki.Certificate | null = null;
  private caKey: forge.pki.rsa.PrivateKey | null = null;
  private cache: Map<string, CertKeyPair> = new Map();
  private cacheOrder: string[] = [];

  constructor(
    private caDir: string,
    private cacheSize: number = 500,
  ) {}

  init(): void {
    fs.mkdirSync(this.caDir, { recursive: true });

    const certPath = path.join(this.caDir, 'ca.crt');
    const keyPath = path.join(this.caDir, 'ca.key');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const certPem = fs.readFileSync(certPath, 'utf-8');
      const keyPem = fs.readFileSync(keyPath, 'utf-8');
      this.caCert = forge.pki.certificateFromPem(certPem);
      this.caKey = forge.pki.privateKeyFromPem(keyPem);
      return;
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs = [
      { name: 'commonName', value: 'RoxyProxy CA' },
      { name: 'organizationName', value: 'RoxyProxy' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
    fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));

    this.caCert = cert;
    this.caKey = keys.privateKey;
  }

  getCertForHost(hostname: string): CertKeyPair {
    if (!this.caCert || !this.caKey) {
      throw new Error('CA not initialized. Call init() first.');
    }

    const cached = this.cache.get(hostname);
    if (cached) {
      this.cacheOrder = this.cacheOrder.filter(h => h !== hostname);
      this.cacheOrder.push(hostname);
      return cached;
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16);
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    ]);

    cert.sign(this.caKey, forge.md.sha256.create());

    const pair: CertKeyPair = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };

    if (this.cacheOrder.length >= this.cacheSize) {
      const evicted = this.cacheOrder.shift()!;
      this.cache.delete(evicted);
    }

    this.cache.set(hostname, pair);
    this.cacheOrder.push(hostname);
    return pair;
  }

  getCaCertPath(): string {
    return path.join(this.caDir, 'ca.crt');
  }
}
