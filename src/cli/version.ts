import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read rather than imported: `tsconfig.server.json` sets `rootDir: "./src"`,
 * and package.json lives outside it.
 */
export function readPackageVersion(): string {
  const { version } = JSON.parse(
    readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
  ) as { version: string };
  return version;
}
