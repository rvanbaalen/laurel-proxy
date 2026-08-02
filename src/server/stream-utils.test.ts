import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { waitForDrain } from './stream-utils.js';
import type { DrainableStream } from './stream-utils.js';

/** The three events waitForDrain cares about, without a real socket. */
class FakeStream extends EventEmitter implements DrainableStream {
  destroyed = false;
}

describe('waitForDrain', () => {
  it('resolves when the stream drains', async () => {
    const stream = new FakeStream();
    const waiting = waitForDrain(stream);
    stream.emit('drain');
    await expect(waiting).resolves.toBeUndefined();
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
  });

  it('rejects when the stream closes without draining', async () => {
    // The hang this exists to prevent: 'drain' never arrives for a stream that
    // went away, so waiting only on it would suspend the transfer forever.
    const stream = new FakeStream();
    const waiting = waitForDrain(stream);
    stream.emit('close');
    await expect(waiting).rejects.toThrow('stream closed');
  });

  it('rejects when the stream errors', async () => {
    const stream = new FakeStream();
    const waiting = waitForDrain(stream);
    stream.emit('error');
    await expect(waiting).rejects.toThrow('stream closed');
  });

  it('rejects immediately for an already destroyed stream', async () => {
    const stream = new FakeStream();
    stream.destroyed = true;
    await expect(waitForDrain(stream)).rejects.toThrow('stream closed');
    // Nothing was subscribed, so nothing can settle it later.
    expect(stream.listenerCount('drain')).toBe(0);
  });

  it('ignores events that arrive after it has settled', async () => {
    const stream = new FakeStream();
    const waiting = waitForDrain(stream);
    stream.emit('drain');
    await waiting;
    // A later close must not turn the settled resolve into a rejection. (Only
    // 'close' is emitted here: an unlistened 'error' throws on a bare emitter,
    // which is exactly the unsubscription this asserts.)
    stream.emit('close');
    await expect(waiting).resolves.toBeUndefined();
  });
});
