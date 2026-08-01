import { describe, it, expect } from 'vitest';
import { resolveHttpTarget, resolveMitmTarget } from './exchange.js';

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
