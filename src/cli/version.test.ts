import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readPackageVersion } from './version.js';

describe('readPackageVersion', () => {
  it('matches package.json rather than a stale hardcoded string', () => {
    // `--version` was hardcoded as '0.1.0' for three releases before this
    // module existed — reading the same file independently here catches a
    // regression back to a literal, not just a broken path.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    expect(readPackageVersion()).toBe(pkg.version);
  });
});
