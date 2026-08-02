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
 * The recorded frames a replay resends: the client's own data frames. Exported
 * so a caller deciding whether a recording is fit to replay asks about the same
 * frames this module would send, rather than re-deriving the predicate.
 */
export function isReplayableFrame(message: WebSocketMessage): boolean {
  return message.direction === 'sent'
    && (message.opcode === 'text' || message.opcode === 'binary');
}

/**
 * Build a replay request from a recorded connection: client-sent data frames
 * only, with delays derived from the original inter-frame gaps.
 *
 * Control frames (ping/pong/close) are dropped — Node's WebSocket manages those
 * itself — and so is everything the server sent, which is what replay collects
 * rather than resends.
 */
export function recordToWsReplayRequest(
  record: RequestRecord,
  messages: WebSocketMessage[],
): WsReplayRequest {
  // The capture stores the handshake's own scheme; only the scheme changes.
  // `^http:` cannot match an `https:` URL, so the order of these two is safe.
  const url = record.url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

  // Filtered before the gaps are measured, so each delay is the wait between
  // two frames this replay actually sends. Measuring across dropped frames
  // would shorten every gap that had a reply or a ping in it. `sort` is stable,
  // so frames decoded from one chunk — which share a timestamp — keep their
  // recorded order.
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
    let sendingComplete = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    // Declared before `finish` closes over it rather than after: a `const`
    // below would leave `finish` reading a binding in its temporal dead zone,
    // safe only for as long as nobody moves a handler above the assignment.
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    // A malformed URL makes the constructor throw, which rejects this promise —
    // that happens before any timer exists, so there is nothing to clean up.
    // `binaryType` is set immediately, since it only governs messages that
    // arrive after it is assigned.
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
        // Derived from the counts rather than from `sendingComplete`, so a
        // replay with nothing to send is complete even when the socket never
        // opened — `frames: []` did send everything it was asked to.
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
      // Silence only means "the server is done" once we have stopped talking.
      // Arming this from a reply that arrives while frames are still queued
      // would end the replay in the middle of a recorded gap longer than the
      // quiet period — a short sentCount reported as a clean run.
      if (!sendingComplete) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('idle'), QUIET_PERIOD);
    };

    // Anything that throws inside an async handler becomes an unhandled
    // rejection that never settles this promise — the caller would hang until
    // the hard timeout with no explanation. Catch and finish explicitly.
    socket.onopen = async () => {
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

    // Captured before `finish` resolves, so a server-initiated close reports
    // its code. `finish` is idempotent, so it does not matter that a close
    // following our own `socket.close()` calls it a second time.
    socket.onclose = (event: CloseEvent) => {
      closeCode = event.code;
      finish('close');
    };

    // Fires both for a connection that never opened and for one that broke
    // mid-replay, hence the wording: `sentCount` says which happened.
    socket.onerror = () => finish('error', `WebSocket connection to ${request.url} failed`);
  });
}
