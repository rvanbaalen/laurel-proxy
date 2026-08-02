import type { RequestRecord, WebSocketMessage } from '../shared/types.js';

export interface StatusEvent {
  running: boolean;
  proxyPort: number;
}

type RequestSubscriber = (events: RequestRecord[]) => void;
type StatusSubscriber = (status: StatusEvent) => void;
type WsMessageSubscriber = (messages: WebSocketMessage[]) => void;

export class EventManager {
  private requestSubscribers: Set<RequestSubscriber> = new Set();
  private statusSubscribers: Set<StatusSubscriber> = new Set();
  private wsSubscribers: Set<WsMessageSubscriber> = new Set();
  private buffer: RequestRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

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

  emitStatus(status: StatusEvent): void {
    for (const sub of this.statusSubscribers) {
      try { sub(status); } catch {}
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    for (const sub of this.requestSubscribers) {
      try { sub(batch); } catch {}
    }
  }

  subscribe(fn: RequestSubscriber): () => void {
    this.requestSubscribers.add(fn);
    return () => { this.requestSubscribers.delete(fn); };
  }

  subscribeStatus(fn: StatusSubscriber): () => void {
    this.statusSubscribers.add(fn);
    return () => { this.statusSubscribers.delete(fn); };
  }

  subscribeWsMessages(fn: WsMessageSubscriber): () => void {
    this.wsSubscribers.add(fn);
    return () => { this.wsSubscribers.delete(fn); };
  }

  /**
   * Stopped means stopped: the pending batch is dropped and every channel is
   * released, so nothing can keep receiving from a manager that is down. All
   * three subscriber sets are cleared — one SSE handler subscribes to all of
   * them, so clearing only some would leave that handler half-connected.
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
