import type { Database } from './db.js';
import type { Config } from '../shared/types.js';
import { recordSafely } from '../shared/recording-safety.js';

export class Cleanup {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private config: Config,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.run(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One retention pass, guarded because it is reached from a `setInterval` —
   * where an escaping throw is an uncaught exception and therefore the end of
   * the process. Every call below can throw in ordinary use: a database locked
   * by another process, a corrupt file, or `SQLITE_FULL` from the vacuum on the
   * same full disk that makes retention matter in the first place. Losing a
   * pruning pass is the acceptable failure; killing the developer's proxy while
   * it is not even carrying traffic is not.
   *
   * Nothing needs dropping the way a failed write batch does, because there is
   * no queue here: the work to be done is derived from the database's own state,
   * so the next tick recomputes it and retries. That retry is bounded by
   * construction — a failing pass leaves nothing behind to accumulate.
   */
  run(): void {
    recordSafely(() => {
      // Delete by age
      const cutoff = Date.now() - this.config.maxAge;
      this.db.deleteOlderThan(cutoff);

      // Delete oldest in batches until under size limit
      while (this.db.getDbSize() > this.config.maxDbSize) {
        const deleted = this.db.deleteOldest(100);
        if (deleted === 0) break;
      }

      // Reclaim disk space
      this.db.incrementalVacuum();
    });
  }
}
