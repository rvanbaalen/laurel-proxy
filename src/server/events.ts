import type { RequestRecord, WebSocketMessage } from '../shared/types.js';

export interface StatusEvent {
  running: boolean;
  proxyPort: number;
}

type RequestSubscriber = (events: RequestRecord[]) => void;
type StatusSubscriber = (status: StatusEvent) => void;
type WsMessageSubscriber = (messages: WebSocketMessage[]) => void;

/**
 * Pub/sub hub between the proxy internals and SSE handlers: batches request
 * records on a timer, but relays WebSocket messages and status changes
 * immediately.
 */
export class EventManager {
  private requestSubscribers: Set<RequestSubscriber> = new Set();
  private statusSubscribers: Set<StatusSubscriber> = new Set();
  private wsSubscribers: Set<WsMessageSubscriber> = new Set();
  private buffer: RequestRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Buffers a record for the next scheduled flush, batching bursts of requests
   * so SSE delivery lags by up to 100ms rather than firing per record.
   */
  push(record: RequestRecord): void {
    this.buffer.push(record);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 100);
    }
  }

  /**
   * Delivered immediately rather than buffered like requests: each call already
   * carries the frames decoded from one relayed chunk, so it is a batch.
   */
  pushWsMessages(messages: WebSocketMessage[]): void {
    if (messages.length === 0) return;
    for (const sub of this.wsSubscribers) {
      try { sub(messages); } catch {}
    }
  }

  /**
   * Notifies every status subscriber synchronously; a subscriber that throws
   * cannot block delivery to the rest.
   */
  emitStatus(status: StatusEvent): void {
    for (const sub of this.statusSubscribers) {
      try { sub(status); } catch {}
    }
  }

  /**
   * Drains the buffered batch to every request subscriber once the 100ms
   * timer fires; a no-op if nothing was buffered.
   */
  private flush(): void {
    this.timer = null;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    for (const sub of this.requestSubscribers) {
      try { sub(batch); } catch {}
    }
  }

  /** Registers a request-batch subscriber and returns an unsubscribe function. */
  subscribe(fn: RequestSubscriber): () => void {
    this.requestSubscribers.add(fn);
    return () => { this.requestSubscribers.delete(fn); };
  }

  /** Registers a status subscriber and returns an unsubscribe function. */
  subscribeStatus(fn: StatusSubscriber): () => void {
    this.statusSubscribers.add(fn);
    return () => { this.statusSubscribers.delete(fn); };
  }

  /** Registers a WebSocket-message subscriber and returns an unsubscribe function. */
  subscribeWsMessages(fn: WsMessageSubscriber): () => void {
    this.wsSubscribers.add(fn);
    return () => { this.wsSubscribers.delete(fn); };
  }

  /**
   * On stop the pending batch is dropped and every subscriber set is cleared,
   * since one SSE handler subscribes to all three and clearing only some
   * would leave it half-connected.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.requestSubscribers.clear();
    this.statusSubscribers.clear();
    this.wsSubscribers.clear();
  }
}
