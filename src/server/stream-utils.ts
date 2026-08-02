/**
 * The slice of a writable stream {@link waitForDrain} needs. Kept structural so
 * both `net.Socket` (the WebSocket relay) and `http.ServerResponse` (the HTTP
 * exchange) satisfy it — in Node's typings the latter is not a `Writable`.
 */
export interface DrainableStream {
  destroyed: boolean;
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
