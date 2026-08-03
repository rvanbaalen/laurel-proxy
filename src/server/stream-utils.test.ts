import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { isGone, waitForDrain } from './stream-utils.js';
import type { DrainableStream } from './stream-utils.js';

/** The three events waitForDrain cares about, without a real socket. */
class FakeStream extends EventEmitter implements DrainableStream {
  destroyed: boolean | undefined = false;
}

/**
 * The shape an `Http2ServerResponse` actually has on Node 22.21.1: no `destroyed`
 * property at all (`'destroyed' in res === false`, and it stays `undefined` even
 * after `res.destroy()`), with the truth on `res.stream`. Measured, not guessed —
 * `@types/node` types the class as extending `stream.Writable`, which is why the
 * blindness was invisible until it was tested for.
 */
class FakeH2Response extends EventEmitter implements DrainableStream {
  readonly destroyed = undefined;
  readonly stream = { destroyed: false };
}

describe('isGone', () => {
  it('reads a real boolean when the stream has one', () => {
    const stream = new FakeStream();
    expect(isGone(stream)).toBe(false);
    stream.destroyed = true;
    expect(isGone(stream)).toBe(true);
  });

  it('falls through to the h2 stream when destroyed is unknown', () => {
    // The whole reason this function exists: `undefined` means "don't know", and
    // the answer lives one level down. Reading `destroyed` alone — which is what
    // every call site did before — can only ever answer `false` for h2.
    const res = new FakeH2Response();
    expect(isGone(res)).toBe(false);
    res.stream.destroyed = true;
    expect(isGone(res)).toBe(true);
  });

  it('reports not-gone when neither source knows', () => {
    // "Unknown" must not read as "gone": bailing out of a healthy transfer is a
    // worse failure than continuing into a dead one, which the close/error
    // listeners catch anyway.
    const opaque: DrainableStream = {
      destroyed: undefined,
      on: () => undefined,
      off: () => undefined,
    };
    expect(isGone(opaque)).toBe(false);
  });
});

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

  it('rejects immediately for an h2 response whose stream is already destroyed', async () => {
    // Before `isGone`, this fast path was dead code for every h2 client:
    // `res.destroyed` is `undefined`, so the check never fired and the wait
    // depended entirely on a `close` event arriving.
    const res = new FakeH2Response();
    res.stream.destroyed = true;
    await expect(waitForDrain(res)).rejects.toThrow('stream closed');
    expect(res.listenerCount('drain')).toBe(0);
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
