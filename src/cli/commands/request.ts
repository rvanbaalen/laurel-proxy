import type { Command } from 'commander';
import { Database } from '../../storage/db.js';
import { loadConfig } from '../../server/config.js';
import { formatRequest } from '../format.js';

export function registerRequest(program: Command): void {
  program
    .command('request <id>')
    .description('Show details of a single request')
    .option('--format <format>', 'Output format (json|table|agent)', 'json')
    .option('--db-path <path>', 'Database path')
    .action((id, opts) => {
      const config = loadConfig(opts.dbPath ? { dbPath: opts.dbPath } : {});
      const db = new Database(config.dbPath);

      const record = db.getById(id);
      if (!record) {
        console.error(`Request ${id} not found.`);
        db.close();
        process.exit(1);
      }

      console.log(formatRequest(record, opts.format));
      db.close();
    });
}
