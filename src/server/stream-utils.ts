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
 * means "unknown", never "not destroyed" — which is why the check below is a
 * fast path and the `close`/`error` listeners, not the check, are what guarantee
 * this settles.
 */
export interface DrainableStream {
  destroyed: boolean | undefined;
  on(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
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
    if (stream.destroyed) {
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
