import { describe, it, expect } from 'vitest';
import { replayWebSocket, recordToWsReplayRequest } from './ws-replay.js';
import { startRawWsServer, echoHandler } from '../../tests/helpers/ws-server.js';
import { encodeFrame } from '../../tests/helpers/ws-frames.js';
import type { RequestRecord, WebSocketMessage } from '../shared/types.js';

function message(overrides: Partial<WebSocketMessage> = {}): WebSocketMessage {
  return {
    id: 'm',
    request_id: 'c',
    timestamp: 1000,
    direction: 'sent',
    opcode: 'text',
    payload: Buffer.from('x'),
    size: 1,
    truncated: 0,
    ...overrides,
  };
}

const texts = (frames: { payload: string }[]): string[] =>
  frames.map((f) => Buffer.from(f.payload, 'base64').toString());

describe('recordToWsReplayRequest', () => {
  it('keeps only client-sent data frames and derives delays from the previous sent frame', () => {
    const record = { url: 'https://example.com/socket' } as RequestRecord;
    const messages: WebSocketMessage[] = [
      message({ id: 'a', timestamp: 1000, payload: Buffer.from('one') }),
      message({ id: 'b', timestamp: 1200, direction: 'received', payload: Buffer.from('ignored') }),
      message({ id: 'c', timestamp: 1500, opcode: 'ping', payload: null, size: 0 }),
      message({ id: 'd', timestamp: 1800, payload: Buffer.from('two') }),
      message({ id: 'e', timestamp: 2000, payload: Buffer.from('three') }),
    ];

    const result = recordToWsReplayRequest(record, messages);

    expect(result.url).toBe('wss://example.com/socket');
    expect(texts(result.frames)).toEqual(['one', 'two', 'three']);
    // Each gap is measured against the previous *sent data* frame, not against
    // whatever message happened to precede it: the received frame at 1200 and
    // the ping at 1500 must not shorten the wait before 'two'. And the third
    // delay pins gap-from-previous rather than offset-from-first (200, not 1000).
    expect(result.frames.map((f) => f.delayMs)).toEqual([0, 800, 200]);
  });

  it('maps http urls to ws scheme', () => {
    const record = { url: 'http://example.com/s' } as RequestRecord;
    expect(recordToWsReplayRequest(record, []).url).toBe('ws://example.com/s');
  });

  it('keeps the port of a recorded url', () => {
    const record = { url: 'https://example.com:8443/s' } as RequestRecord;
    expect(recordToWsReplayRequest(record, []).url).toBe('wss://example.com:8443/s');
  });

  it('turns a frame recorded with no payload into an empty frame', () => {
    const record = { url: 'ws://example.com/s' } as RequestRecord;
    const result = recordToWsReplayRequest(record, [
      message({ payload: null, size: 0 }),
    ]);
    // Not the string "null", and not a throw: an empty text frame.
    expect(result.frames).toEqual([{ opcode: 'text', payload: '', delayMs: 0 }]);
  });
});

describe('replayWebSocket', () => {
  it('resends frames and collects replies', async () => {
    const server = await startRawWsServer({ onMessage: echoHandler });
    try {
      const result = await replayWebSocket({
        url: `ws://127.0.0.1:${server.port}/s`,
        frames: [
          { opcode: 'text', payload: Buffer.from('alpha').toString('base64'), delayMs: 0 },
          { opcode: 'text', payload: Buffer.from('beta').toString('base64'), delayMs: 10 },
        ],
        timeoutMs: 5000,
      });

      expect(result.error).toBeUndefined();
      expect(result.sentCount).toBe(2);
      expect(texts(result.received)).toEqual(['re:alpha', 're:beta']);
      expect(result.received.every((r) => r.opcode === 'text')).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  }, 15_000);

  it('round-trips a binary frame whose bytes are not valid UTF-8', async () => {
    const server = await startRawWsServer({ onMessage: echoHandler });
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01]);
    try {
      const result = await replayWebSocket({
        url: `ws://127.0.0.1:${server.port}/s`,
        frames: [{ opcode: 'binary', payload: raw.toString('base64'), delayMs: 0 }],
        timeoutMs: 5000,
      });

      expect(result.sentCount).toBe(1);
      expect(result.received).toHaveLength(1);
      // A binary frame must not be routed through a utf8 round trip, in either
      // direction — that would replace these bytes with U+FFFD.
      expect(result.received[0].opcode).toBe('binary');
      expect(Buffer.from(result.received[0].payload, 'base64').equals(raw)).toBe(true);
    } finally {
      server.close();
    }
  }, 15_000);

  it('waits the recorded delay before resending the next frame', async () => {
    const arrivals: number[] = [];
    const server = await startRawWsServer({
      onMessage: (m) => { if (m.opcode === 'text') arrivals.push(Date.now()); },
    });
    try {
      const result = await replayWebSocket({
        url: `ws://127.0.0.1:${server.port}/s`,
        frames: [
          { opcode: 'text', payload: Buffer.from('first').toString('base64'), delayMs: 0 },
          { opcode: 'text', payload: Buffer.from('second').toString('base64'), delayMs: 250 },
        ],
        timeoutMs: 5000,
      });

      expect(result.sentCount).toBe(2);
      expect(arrivals).toHaveLength(2);
      // Timing fidelity is the point of the feature: the gap has to be honoured,
      // not collapsed. Lower bound only — the scheduler may add slack.
      expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(200);
    } finally {
      server.close();
    }
  }, 15_000);

  it('sends every frame even when a reply arrives before a long recorded gap', async () => {
    // Regression: the idle countdown used to be armed by any inbound message,
    // including one that arrived while frames were still queued. A recorded gap
    // longer than the quiet period then finished the replay early — silently,
    // with a short sentCount and no error.
    const server = await startRawWsServer({ onMessage: echoHandler });
    try {
      const result = await replayWebSocket({
        url: `ws://127.0.0.1:${server.port}/s`,
        frames: [
          { opcode: 'text', payload: Buffer.from('alpha').toString('base64'), delayMs: 0 },
          { opcode: 'text', payload: Buffer.from('beta').toString('base64'), delayMs: 700 },
        ],
        timeoutMs: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.sentCount).toBe(2);
      expect(texts(result.received)).toEqual(['re:alpha', 're:beta']);
    } finally {
      server.close();
    }
  }, 20_000);

  it('finishes on the quiet period rather than the timeout when nothing replies', async () => {
    const server = await startRawWsServer();
    try {
      const result = await replayWebSocket({
        url: `ws://127.0.0.1:${server.port}/s`,
        frames: [{ opcode: 'text', payload: Buffer.from('hello').toString('base64'), delayMs: 0 }],
        timeoutMs: 10_000,
      });

      expect(result.sentCount).toBe(1);
      expect(result.received).toEqual([]);
      expect(result.error).toBeUndefined();
      // A silent server must not hold the caller for the full timeout.
      expect(result.durationMs).toBeLessThan(5000);
    } finally {
      server.close();
    }
  }, 20_000);

  it('reports the timeout for a server that never stops talking', async () => {
    const timers: NodeJS.Timeout[] = [];
    const server = await startRawWsServer({
      onOpen: (socket) => {
        // Faster than the quiet period, so only the hard timeout can end this.
        timers.push(setInterval(() => socket.write(encodeFrame('text', Buffer.from('tick'))), 50));
      },
    });
    try {
      const result = await replayWebSocket({
        url: `ws://127.0.0.1:${server.port}/s`,
        frames: [],
        timeoutMs: 800,
      });

      expect(result.error).toMatch(/timed out/);
      expect(result.received.length).toBeGreaterThan(1);
    } finally {
      for (const timer of timers) clearInterval(timer);
      server.close();
    }
  }, 20_000);

  it('reports a connection error rather than throwing', async () => {
    const result = await replayWebSocket({
      url: 'ws://127.0.0.1:1/nope',
      frames: [],
      timeoutMs: 5000,
    });
    expect(result.error).toBeTruthy();
    expect(result.sentCount).toBe(0);
    expect(result.received).toEqual([]);
  }, 15_000);

  it('rejects a non-ws url', async () => {
    await expect(
      replayWebSocket({ url: 'https://example.com/x', frames: [] }),
    ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
  });

  it('rejects a syntactically invalid ws url instead of throwing synchronously', async () => {
    await expect(replayWebSocket({ url: 'ws://', frames: [] })).rejects.toThrow();
  });
});
