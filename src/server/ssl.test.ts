import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CertificateAuthority } from './ssl.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

describe('CertificateAuthority', () => {
  let caDir: string;
  let ca: CertificateAuthority;

  beforeEach(() => {
    caDir = path.join(os.tmpdir(), `roxyproxy-ca-test-${randomUUID()}`);
    ca = new CertificateAuthority(caDir, 10);
  });

  afterEach(() => {
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('generates CA cert and key on init', () => {
    ca.init();
    expect(fs.existsSync(path.join(caDir, 'ca.crt'))).toBe(true);
    expect(fs.existsSync(path.join(caDir, 'ca.key'))).toBe(true);
  });

  it('reuses existing CA cert on subsequent init', () => {
    ca.init();
    const certBefore = fs.readFileSync(path.join(caDir, 'ca.crt'), 'utf-8');
    ca.init();
    const certAfter = fs.readFileSync(path.join(caDir, 'ca.crt'), 'utf-8');
    expect(certBefore).toBe(certAfter);
  });

  it('generates a domain certificate', () => {
    ca.init();
    const { cert, key } = ca.getCertForHost('example.com');
    expect(cert).toContain('-----BEGIN CERTIFICATE-----');
    expect(key).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('caches domain certificates', () => {
    ca.init();
    const first = ca.getCertForHost('example.com');
    const second = ca.getCertForHost('example.com');
    expect(first.cert).toBe(second.cert);
  });

  it('evicts least-recently-used certs when cache is full', () => {
    ca = new CertificateAuthority(caDir, 2);
    ca.init();
    ca.getCertForHost('a.com');
    ca.getCertForHost('b.com');
    ca.getCertForHost('c.com');
    const freshA = ca.getCertForHost('a.com');
    expect(freshA.cert).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('returns CA cert path', () => {
    ca.init();
    expect(ca.getCaCertPath()).toBe(path.join(caDir, 'ca.crt'));
  });
});
