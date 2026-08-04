import type {
  RequestRecord,
  WebSocketMessage,
  WsReplayFrame,
  WsReplayRequest,
  WsReplayResponse,
  WsReplayStopReason,
} from '../shared/types.js';

const DEFAULT_TIMEOUT = 30_000;
/** Idle window after the last frame before we assume the server is done replying. */
const QUIET_PERIOD = 500;

/**
 * The recorded frames a replay resends: the client's own data frames. Exported so
 * a caller deciding whether a recording is fit to replay asks about the same
 * frames this module would send, rather than re-deriving the predicate.
 */
export function isReplayableFrame(message: WebSocketMessage): boolean {
  return message.direction === 'sent'
    && (message.opcode === 'text' || message.opcode === 'binary');
}

/**
 * Builds a replay request from a recording: the client's data frames, with delays derived
 * from their original gaps. Drops control frames, which the WebSocket API manages
 * itself, and server replies, which replay collects rather than resends.
 */
export function recordToWsReplayRequest(
  record: RequestRecord,
  messages: WebSocketMessage[],
): WsReplayRequest {
  // The capture stores the handshake's own scheme; only the scheme changes.
  // `^http:` cannot match an `https:` URL, so the order of these two is safe.
  const url = record.url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

  // Filtered before gaps are measured, so each delay reflects only sent frames.
  // `sort` is stable, so frames decoded from one chunk keep their recorded order.
  const sent = messages
    .filter(isReplayableFrame)
    .sort((a, b) => a.timestamp - b.timestamp);

  const frames: WsReplayFrame[] = sent.map((message, index) => ({
    opcode: message.opcode as 'text' | 'binary',
    // A frame recorded with no payload replays as an empty frame of the same
    // opcode: base64 of nothing, not the string "null".
    payload: message.payload ? Buffer.from(message.payload).toString('base64') : '',
    delayMs: index === 0 ? 0 : message.timestamp - sent[index - 1].timestamp,
  }));

  return { url, frames };
}

/**
 * Reopens a WebSocket connection, resends the given frames with their recorded
 * spacing, and collects whatever comes back.
 *
 * Termination is a heuristic, because a WebSocket has no response boundary to
 * wait for: once every frame is sent, the replay ends after `QUIET_PERIOD` of
 * silence, or when the server closes, or at `timeoutMs` — whichever comes
 * first. `stoppedBecause` always says which, because the heuristic is not
 * reliable enough to leave implicit: a server that takes longer than the quiet
 * period to produce its *first* reply ends the replay as `idle` with nothing
 * collected, which is not the same thing as a server that had nothing to say.
 * Only the timeout and outright failures set `error`.
 *
 * The returned promise rejects only for a URL that is not a WebSocket URL.
 * Every network outcome resolves, carrying `error` when something went wrong,
 * so a caller always learns how many frames actually went out.
 *
 * `stoppedBecause` alone cannot say whether the replay finished its job: the
 * close path can end it mid-send, and `'close'` with a short `sentCount` looks
 * exactly like a clean run. `sentAll` and `frameCount` are reported for that
 * reason — an incomplete send is a fact about the replay, not something a caller
 * should have to reconstruct by re-counting the frames it passed in.
 */
export function replayWebSocket(request: WsReplayRequest): Promise<WsReplayResponse> {
  if (!request.url.startsWith('ws://') && !request.url.startsWith('wss://')) {
    return Promise.reject(new Error(`URL must start with ws:// or wss://: ${request.url}`));
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT;
  const startedAt = Date.now();

  return new Promise<WsReplayResponse>((resolve) => {
    const received: WsReplayResponse['received'] = [];
    let sentCount = 0;
    let closeCode: number | null = null;
    let settled = false;
    let opened = false;
    let sendingComplete = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    // Declared before `finish` closes over it; a `const` here would leave
    // `finish` reading the binding in its temporal dead zone.
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    // A malformed URL throws in the constructor, rejecting this promise before
    // any timer exists — there is nothing to clean up yet.
    const socket = new WebSocket(request.url);
    socket.binaryType = 'arraybuffer';

    const finish = (stoppedBecause: WsReplayStopReason, error?: string) => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try { socket.close(); } catch { /* already closing or closed */ }
      resolve({
        sentCount,
        frameCount: request.frames.length,
        // Derived from the counts, not `sendingComplete`, so a replay with nothing
        // to send counts as complete even when the socket never opened.
        sentAll: sentCount === request.frames.length,
        received,
        durationMs: Date.now() - startedAt,
        closeCode,
        stoppedBecause,
        ...(error ? { error } : {}),
      });
    };

    hardTimer = setTimeout(() => finish('timeout', 'Replay timed out'), timeoutMs);

    const armQuietTimer = () => {
      // Meaningful only once we've stopped sending; arming it while frames are
      // still queued could end the replay mid-gap, misread as a clean run.
      if (!sendingComplete) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('idle'), QUIET_PERIOD);
    };

    // An uncaught throw here becomes an unhandled rejection, not a settled
    // promise, leaving the caller hanging until the hard timeout.
    socket.onopen = async () => {
      opened = true;
      try {
        for (const frame of request.frames) {
          if (settled) return;
          if (frame.delayMs > 0) {
            await new Promise((r) => setTimeout(r, frame.delayMs));
          }
          if (settled) return;
          const bytes = Buffer.from(frame.payload, 'base64');
          // A text frame has to go out as a string — passing a Buffer would
          // send it as binary and change the opcode the server sees.
          socket.send(frame.opcode === 'text' ? bytes.toString('utf8') : bytes);
          sentCount++;
        }
        sendingComplete = true;
        armQuietTimer();
      } catch (err) {
        finish('error', `Failed while sending frames: ${(err as Error).message}`);
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      const isText = typeof event.data === 'string';
      const payload = isText
        ? Buffer.from(event.data as string, 'utf8')
        : Buffer.from(event.data as ArrayBuffer);
      received.push({
        opcode: isText ? 'text' : 'binary',
        payload: payload.toString('base64'),
        offsetMs: Date.now() - startedAt,
      });
      armQuietTimer();
    };

    // Captured before `finish` resolves, so a server-initiated close still
    // reports its code; `finish`'s idempotence covers the resulting double call.
    socket.onclose = (event: CloseEvent) => {
      closeCode = event.code;
      finish('close');
    };

    // Node 24's WebSocket also fires `error` for an abrupt disconnect after a
    // successful open — an undici bug, not a real failure — so once opened,
    // only the `close` that always follows (with the real code) settles it.
    socket.onerror = () => {
      if (!opened) finish('error', `WebSocket connection to ${request.url} failed`);
    };
  });
}
