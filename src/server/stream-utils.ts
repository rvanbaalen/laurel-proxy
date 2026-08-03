/**
 * The slice of a writable stream {@link waitForDrain} needs. Kept structural so
 * that `net.Socket` (the WebSocket relay), `http.ServerResponse` (the HTTP
 * exchange) and `Http2ServerResponse` all satisfy it — in Node's typings the
 * second is not a `Writable`, and the third is a separate class from the second.
 *
 * `destroyed` is `boolean | undefined` because on Node 22.21.1 an
 * `Http2ServerResponse` **does not have the property at all**, despite
 * `@types/node` declaring it (the class is typed as extending `stream.Writable`;
 * the compatibility object only forwards some of that surface, and `destroyed`
 * lives on `res.stream`). Measured, not read from the docs. So `undefined` here
 * means "unknown", never "not destroyed", and {@link isGone} — not this property
 * — is what callers should ask. The `close`/`error` listeners below remain the
 * guarantee that a drain wait settles; the check is only a fast path.
 */
export interface DrainableStream {
  destroyed: boolean | undefined;
  /**
   * The HTTP/2 stream behind an `Http2ServerResponse`, absent on every HTTP/1.1
   * shape. It is where the truth about `destroyed` actually lives for h2, so
   * naming it here is what lets {@link isGone} answer the question for both
   * protocols instead of only one — see the `destroyed` note above.
   */
  readonly stream?: { readonly destroyed: boolean } | undefined;
  on(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
}

/**
 * Whether this stream is definitely finished with.
 *
 * The fall-through is the point. `destroyed === undefined` means *unknown*, which
 * for an `Http2ServerResponse` is the only value it ever has, so the question has
 * to be put to `res.stream`, where Node keeps the answer. `?? false` at the end is
 * reached only when neither source knows, and "not known to be gone" is the answer
 * that keeps a caller from bailing out of a healthy transfer.
 *
 * `??` rather than `||` for meaning rather than for behaviour: no shape in this
 * codebase reports `destroyed === false` while carrying a destroyed `stream`, so
 * the two operators agree on every input that actually occurs, and no test can
 * distinguish them. `??` is nonetheless what is meant — consult the second source
 * because the first *does not know*, not because it said no.
 *
 * Nothing about the HTTP/1.1 case changes: `destroyed` is a real boolean there,
 * so the first term always decides and `stream` is not even present.
 */
export function isGone(stream: DrainableStream): boolean {
  return stream.destroyed ?? stream.stream?.destroyed ?? false;
}

/**
 * Resolves once `stream` can take more data, after a `write()` returned false.
 *
 * A close or an error settles it too, as a rejection. Awaiting only 'drain'
 * would never return for a stream that went away without erroring — the awaiting
 * transfer would stay suspended forever, holding both ends of the exchange open.
 */
export function waitForDrain(stream: DrainableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isGone(stream)) {
      reject(new Error('stream closed'));
      return;
    }
    const settle = (finish: () => void) => () => {
      stream.off('drain', onDrain);
      stream.off('close', onGone);
      stream.off('error', onGone);
      finish();
    };
    const onDrain = settle(resolve);
    const onGone = settle(() => reject(new Error('stream closed')));
    stream.on('drain', onDrain);
    stream.on('close', onGone);
    stream.on('error', onGone);
  });
}
