import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import { resolveHttpTarget, resolveMitmTarget, handleExchange } from './exchange.js';
import { DEFAULT_CONFIG } from '../shared/types.js';

describe('resolveHttpTarget', () => {
  it('parses an absolute-form proxy URL', () => {
    expect(resolveHttpTarget('http://example.com/a/b?c=1')).toEqual({
      hostname: 'example.com',
      port: 80,
      protocol: 'http',
      url: 'http://example.com/a/b?c=1',
      path: '/a/b?c=1',
    });
  });

  it('honours an explicit port', () => {
    expect(resolveHttpTarget('http://example.com:8080/x')?.port).toBe(8080);
  });

  it('returns null for a non-absolute URL', () => {
    expect(resolveHttpTarget('/relative')).toBeNull();
  });
});

describe('resolveMitmTarget', () => {
  it('builds an https target from CONNECT host and path', () => {
    expect(resolveMitmTarget('example.com', 443, '/a?b=2')).toEqual({
      hostname: 'example.com',
      port: 443,
      protocol: 'https',
      url: 'https://example.com/a?b=2',
      path: '/a?b=2',
    });
  });
});

describe('handleExchange', () => {
  it('does not record an exchange whose response stream fails mid-transfer', async () => {
    // Upstream sends a partial body, then resets the connection before it
    // ends — simulating a network failure partway through the response.
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial-data');
      setTimeout(() => res.socket?.destroy(), 30);
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const onRecord = vi.fn();
    const proxyServer = http.createServer((clientReq, clientRes) => {
      const target = resolveHttpTarget(`http://127.0.0.1:${upstreamPort}${clientReq.url}`);
      if (!target) {
        clientRes.writeHead(400);
        clientRes.end();
        return;
      }
      void handleExchange(clientReq, clientRes, target, { config: DEFAULT_CONFIG, onRecord });
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, resolve));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;

    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/reset', method: 'GET' },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
          res.on('error', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    // Give handleExchange a moment to settle after the stream error.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onRecord).not.toHaveBeenCalled();

    proxyServer.close();
    upstream.close();
  });
});
