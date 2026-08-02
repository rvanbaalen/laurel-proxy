import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventManager } from './events.js';
import type { RequestRecord, WebSocketMessage } from '../shared/types.js';

function makeRequest(id: string): RequestRecord {
  return {
    id,
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://example.com',
    host: 'example.com',
    path: '/',
    protocol: 'http',
    request_headers: '{}',
    request_body: null,
    request_size: 0,
    status: 200,
    response_headers: '{}',
    response_body: null,
    response_size: 0,
    duration: 50,
    content_type: 'text/html',
    truncated: 0,
  };
}

function makeWsMessage(id: string): WebSocketMessage {
  return {
    id,
    request_id: 'c1',
    timestamp: Date.now(),
    direction: 'sent',
    opcode: 'text',
    payload: Buffer.from('hi'),
    size: 2,
    truncated: 0,
  };
}

describe('EventManager', () => {
  let em: EventManager;

  beforeEach(() => {
    vi.useFakeTimers();
    em = new EventManager();
  });

  afterEach(() => {
    em.stop();
    vi.useRealTimers();
  });

  it('emits events to subscribers', () => {
    const received: RequestRecord[] = [];
    em.subscribe((events) => received.push(...events));
    em.push(makeRequest('r1'));
    vi.advanceTimersByTime(150);
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('r1');
  });

  it('batches events within 100ms window', () => {
    let callCount = 0;
    em.subscribe(() => { callCount++; });
    em.push(makeRequest('r1'));
    em.push(makeRequest('r2'));
    em.push(makeRequest('r3'));
    vi.advanceTimersByTime(150);
    expect(callCount).toBe(1);
  });

  it('removes subscriber on unsubscribe', () => {
    const received: RequestRecord[] = [];
    const unsub = em.subscribe((events) => received.push(...events));
    unsub();
    em.push(makeRequest('r1'));
    vi.advanceTimersByTime(150);
    expect(received).toHaveLength(0);
  });

  it('delivers websocket messages to subscribers', () => {
    const seen: WebSocketMessage[][] = [];
    em.subscribeWsMessages((batch) => seen.push(batch));
    em.pushWsMessages([makeWsMessage('w1')]);
    expect(seen).toHaveLength(1);
    expect(seen[0][0].id).toBe('w1');
  });

  it('stops delivering websocket messages after unsubscribe', () => {
    const seen: WebSocketMessage[][] = [];
    const unsub = em.subscribeWsMessages((batch) => seen.push(batch));
    unsub();
    em.pushWsMessages([makeWsMessage('w2')]);
    expect(seen).toHaveLength(0);
  });
});
