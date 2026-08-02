import { describe, it, expect, vi, afterEach } from 'vitest';
import { Cleanup } from './cleanup.js';
import type { Database } from './db.js';
import { DEFAULT_CONFIG } from '../shared/types.js';
import { watchProcessErrors } from '../../tests/helpers/process-errors.js';

/** The retention interval `Cleanup.start()` uses. */
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;

interface Attempts {
  deleteOlderThan: number;
  getDbSize: number;
  deleteOldest: number;
  incrementalVacuum: number;
}

/**
 * A Database that counts what retention asked of it and can be told to fail.
 *
 * `Cleanup` reaches only these four methods, so a four-method stand-in covers
 * it, and a stub is what makes the failure deterministic: the real one throws
 * from exactly here when the database is locked by another process, when the
 * file is corrupt, or when `incrementalVacuum` runs out of disk — the same
 * `SQLITE_FULL` that motivated guarding the write flush.
 */
function createDb(failFor: () => boolean): { db: Database; attempts: Attempts } {
  const attempts: Attempts = {
    deleteOlderThan: 0,
    getDbSize: 0,
    deleteOldest: 0,
    incrementalVacuum: 0,
  };
  const db = {
    deleteOlderThan(): number {
      attempts.deleteOlderThan++;
      if (failFor()) throw new Error('SQLITE_BUSY: database is locked');
      return 0;
    },
    getDbSize(): number {
      attempts.getDbSize++;
      return 0;
    },
    deleteOldest(): number {
      attempts.deleteOldest++;
      return 0;
    },
    incrementalVacuum(): void {
      attempts.incrementalVacuum++;
      if (failFor()) throw new Error('SQLITE_FULL: database or disk is full');
    },
  };
  return { db: db as unknown as Database, attempts };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules retention on a timer, which is why a throw there is fatal', () => {
    // Establishes the mechanism the next test relies on: `run()` is reached from
    // a timer callback, so an escaping throw is an uncaught exception rather than
    // something a caller could handle. Fake timers here only to avoid waiting
    // five real minutes; the next test uses a real timer at a short interval so
    // the escape path itself is the real one.
    vi.useFakeTimers();
    const { db, attempts } = createDb(() => false);
    const cleanup = new Cleanup(db, DEFAULT_CONFIG);

    cleanup.start();
    expect(attempts.deleteOlderThan).toBe(0);
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
    expect(attempts.deleteOlderThan).toBe(1);

    cleanup.stop();
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS * 3);
    expect(attempts.deleteOlderThan).toBe(1);
  });

  it('keeps the process alive when retention throws', async () => {
    const { db, attempts } = createDb(() => true);
    const cleanup = new Cleanup(db, DEFAULT_CONFIG);

    const escaped = await watchProcessErrors(async () => {
      // The same dispatch `start()` uses — a real timer callback with no caller
      // above it — at an interval short enough for a test. A throw here is an
      // uncaught exception, and a proxy whose disk filled up must lose the
      // pruning, not the process.
      const timer = setInterval(() => cleanup.run(), 10);
      await sleep(80);
      clearInterval(timer);
    });

    expect(escaped).toEqual([]);
    // Still being attempted, tick after tick: the retention work lives in the
    // database, not in a queue, so there is nothing to drop and nothing to grow.
    expect(attempts.deleteOlderThan).toBeGreaterThan(1);
  });

  it('prunes normally on a later tick once the database recovers', async () => {
    let broken = true;
    const { db, attempts } = createDb(() => broken);
    const cleanup = new Cleanup(db, DEFAULT_CONFIG);

    const escaped = await watchProcessErrors(async () => {
      const timer = setInterval(() => cleanup.run(), 10);
      await sleep(50);
      broken = false;
      await sleep(50);
      clearInterval(timer);
    });

    expect(escaped).toEqual([]);
    // A failed pass costs that pass only. Once the lock clears, the next tick
    // does the whole job — including the vacuum the failing passes never reached.
    expect(attempts.getDbSize).toBeGreaterThan(0);
    expect(attempts.incrementalVacuum).toBeGreaterThan(0);
  });
});
