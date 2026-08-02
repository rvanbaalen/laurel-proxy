import { describe, it, expect, vi, afterEach } from 'vitest';
import { Cleanup } from './cleanup.js';
import type { Database } from './db.js';
import { DEFAULT_CONFIG } from '../shared/types.js';
import { watchProcessErrors } from '../../tests/helpers/process-errors.js';

/** The retention interval `Cleanup.start()` uses. */
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;

type Step =
  | 'deleteOlderThan'
  | 'getDbSize'
  | 'deleteOldest'
  | 'deleteOrphanedWebSocketMessages'
  | 'incrementalVacuum';

interface Stub {
  db: Database;
  attempts: Record<Step, number>;
  /** Every step reached, in order, across all passes. */
  sequence: Step[];
}

/**
 * A Database that counts what retention asked of it and can be told which step
 * fails.
 *
 * `Cleanup` reaches only these five methods, so a five-method stand-in covers
 * it, and a stub is what makes the failure deterministic: the real one throws
 * from exactly here when the database is locked by another process, when the
 * file is corrupt, or when `incrementalVacuum` runs out of disk — the same
 * `SQLITE_FULL` that motivated guarding the write flush.
 */
function createDb(fails: (step: Step) => boolean): Stub {
  const attempts: Record<Step, number> = {
    deleteOlderThan: 0,
    getDbSize: 0,
    deleteOldest: 0,
    deleteOrphanedWebSocketMessages: 0,
    incrementalVacuum: 0,
  };
  const sequence: Step[] = [];
  const enter = (step: Step): void => {
    attempts[step]++;
    sequence.push(step);
    if (fails(step)) throw new Error(`SQLITE_BUSY: database is locked (${step})`);
  };
  const db = {
    deleteOlderThan(): number {
      enter('deleteOlderThan');
      return 0;
    },
    getDbSize(): number {
      enter('getDbSize');
      return 0;
    },
    deleteOldest(): number {
      enter('deleteOldest');
      return 0;
    },
    deleteOrphanedWebSocketMessages(): number {
      enter('deleteOrphanedWebSocketMessages');
      return 0;
    },
    incrementalVacuum(): void {
      enter('incrementalVacuum');
    },
  };
  return { db: db as unknown as Database, attempts, sequence };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const never = (): boolean => false;
const always = (): boolean => true;

describe('Cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules retention on a timer, which is why a throw there is fatal', () => {
    // Establishes the mechanism the survival tests rely on: `run()` is reached
    // from a timer callback, so an escaping throw is an uncaught exception rather
    // than something a caller could handle. Fake timers here only to avoid
    // waiting five real minutes; the survival tests use a real timer at a short
    // interval so the escape path itself is the real one.
    vi.useFakeTimers();
    const { db, attempts } = createDb(never);
    const cleanup = new Cleanup(db, DEFAULT_CONFIG);

    cleanup.start();
    expect(attempts.deleteOlderThan).toBe(0);
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
    expect(attempts.deleteOlderThan).toBe(1);

    cleanup.stop();
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS * 3);
    expect(attempts.deleteOlderThan).toBe(1);
  });

  it('sweeps orphaned frames as part of a pass, before reclaiming space', () => {
    const { db, sequence } = createDb(never);

    new Cleanup(db, DEFAULT_CONFIG).run();

    // The sweep is the only path that can reclaim frames whose connection row
    // the write flush dropped, so it belongs in the pass that runs unattended —
    // and it has to precede the vacuum, or the pages it frees wait another five
    // minutes to be handed back.
    expect(sequence).toEqual([
      'deleteOlderThan',
      'getDbSize',
      'deleteOrphanedWebSocketMessages',
      'incrementalVacuum',
    ]);
  });

  it('keeps the process alive when retention throws', async () => {
    const { db, attempts } = createDb(always);
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

  it('keeps the process alive when only the orphan sweep throws', async () => {
    const { db, attempts } = createDb((step) => step === 'deleteOrphanedWebSocketMessages');
    const cleanup = new Cleanup(db, DEFAULT_CONFIG);

    const escaped = await watchProcessErrors(async () => {
      const timer = setInterval(() => cleanup.run(), 10);
      await sleep(80);
      clearInterval(timer);
    });

    // The sweep was added to close a leak; it must not open a worse hole by
    // sitting outside the guard that covers the rest of the pass.
    expect(escaped).toEqual([]);
    expect(attempts.deleteOrphanedWebSocketMessages).toBeGreaterThan(1);
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
    // does the whole job — including the sweep and the vacuum the failing passes
    // never reached.
    expect(attempts.getDbSize).toBeGreaterThan(0);
    expect(attempts.deleteOrphanedWebSocketMessages).toBeGreaterThan(0);
    expect(attempts.incrementalVacuum).toBeGreaterThan(0);
  });
});
