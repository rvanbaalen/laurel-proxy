import type { Database } from './db.js';
import type { Config } from '../shared/types.js';
import { neverFatal } from '../shared/never-fatal.js';

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
   * One retention pass, guarded because a `setInterval` callback that throws becomes
   * an uncaught exception and ends the process outright. Every step below
   * can fail in ordinary use — a locked db, a corrupt file, disk-full.
   */
  run(): void {
    neverFatal(() => {
      const cutoff = Date.now() - this.config.maxAge;
      this.db.deleteOlderThan(cutoff);

      while (this.db.getDbSize() > this.config.maxDbSize) {
        const deleted = this.db.deleteOldest(100);
        if (deleted === 0) break;
      }

      // Reclaims frames the write flush dropped independently of their
      // connection row; runs before the vacuum so freed pages return now.
      this.db.deleteOrphanedWebSocketMessages();

      this.db.incrementalVacuum();
    });
  }
}
