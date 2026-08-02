import { describe, it, expect } from 'vitest';
import { activePreset, escapeWsControlChars, formatWsPayload, describeReplayOutcome, mergeWsMessages, parseThrottleInputs, recordKind } from './client.ts';
import type { ThrottleState, WsOpcode, WsReplayResponse, UiWsMessage } from './client.ts';

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

const presets: ThrottleState['presets'] = {
  '56k': { downKbps: 56, upKbps: 33, latencyMs: 120 },
  edge: { downKbps: 240, upKbps: 200, latencyMs: 400 },
  '3g': { downKbps: 780, upKbps: 330, latencyMs: 100 },
  '4g': { downKbps: 4000, upKbps: 3000, latencyMs: 20 },
  dsl: { downKbps: 2000, upKbps: 256, latencyMs: 40 },
  wifi: { downKbps: 30000, upKbps: 15000, latencyMs: 5 },
};

function state(settings: ThrottleState['settings']): ThrottleState {
  return { settings, presets };
}

describe('activePreset', () => {
  it('returns "off" when throttling is disabled, even if values match a preset', () => {
    const s = state({ enabled: false, downKbps: 780, upKbps: 330, latencyMs: 100 });
    expect(activePreset(s)).toBe('off');
  });

  it('returns "unknown" when state is null (not yet loaded, or fetch failed)', () => {
    // This must NOT collapse into 'off' — an unloaded/failed fetch is not the
    // same claim as "throttling is confirmed disabled", and misreporting one
    // as the other is the same failure class the custom-vs-off case guards
    // against, just with 'unknown' in place of 'custom'.
    expect(activePreset(null)).toBe('unknown');
  });

  it('returns the matching preset key when enabled settings exactly match a preset', () => {
    const s = state({ enabled: true, downKbps: 780, upKbps: 330, latencyMs: 100 });
    expect(activePreset(s)).toBe('3g');
  });

  it('matches every documented preset exactly', () => {
    for (const [key, profile] of Object.entries(presets)) {
      const s = state({ enabled: true, ...profile });
      expect(activePreset(s)).toBe(key);
    }
  });

  it('returns "custom" when settings match no preset at all', () => {
    const s = state({ enabled: true, downKbps: 1234, upKbps: 999, latencyMs: 77 });
    expect(activePreset(s)).toBe('custom');
  });

  it('returns "custom" when settings partially match a preset (right downKbps, wrong latencyMs)', () => {
    // Naive implementations that only compare downKbps (or a subset of fields)
    // would wrongly report "3g" here.
    const s = state({ enabled: true, downKbps: 780, upKbps: 330, latencyMs: 999 });
    expect(activePreset(s)).toBe('custom');
  });

  it('returns "custom" when settings partially match a preset (right upKbps/latencyMs, wrong downKbps)', () => {
    const s = state({ enabled: true, downKbps: 1, upKbps: 330, latencyMs: 100 });
    expect(activePreset(s)).toBe('custom');
  });
});

describe('escapeWsControlChars', () => {
  it('leaves ordinary printable text untouched', () => {
    expect(escapeWsControlChars('hello, world! 123 üñî')).toBe('hello, world! 123 üñî');
  });

  it('escapes named C0 control characters using their mnemonic form', () => {
    // 0x07=\a 0x08=\b 0x09=\t 0x0a=\n 0x0d=\r 0x1b=\e
    const input = '\x07\x08\x09\x0a\x0d\x1b';
    expect(escapeWsControlChars(input)).toBe('\\a\\b\\t\\n\\r\\e');
  });

  it('escapes NUL and DEL specifically (not just "any control char")', () => {
    // A naive `code < 0x20` check alone would miss 0x7f (DEL), which is not < 0x20.
    expect(escapeWsControlChars('\x00')).toBe('\\0');
    expect(escapeWsControlChars('\x7f')).toBe('\\x7f');
  });

  it('falls back to zero-padded lowercase \\xHH for unmapped control bytes', () => {
    expect(escapeWsControlChars('\x01')).toBe('\\x01');
  });
});

describe('formatWsPayload', () => {
  function msg(opcode: WsOpcode, payload: string | null, size: number) {
    return { opcode, payload, size };
  }

  it('reports a null payload distinctly rather than an empty string', () => {
    // Rendering this the same as "" would misreport a message with no payload
    // data as an empty-but-present payload.
    expect(formatWsPayload(msg('text', null, 0))).toBe('(no payload)');
  });

  it('shows "<N bytes>" for binary frames without attempting to decode them', () => {
    const payload = b64('\x00\x01\x02\xff');
    expect(formatWsPayload(msg('binary', payload, 4))).toBe('<4 bytes>');
  });

  it('shows "<N bytes>" for control opcodes (ping/pong/close) even if a payload exists', () => {
    // Matches the CLI's wsPayloadPreview: only 'text' gets decoded.
    expect(formatWsPayload(msg('ping', b64('hi'), 2))).toBe('<2 bytes>');
    expect(formatWsPayload(msg('pong', b64('hi'), 2))).toBe('<2 bytes>');
    expect(formatWsPayload(msg('close', b64(''), 0))).toBe('<0 bytes>');
  });

  it('decodes plain (non-JSON) text frames as UTF-8', () => {
    expect(formatWsPayload(msg('text', b64('hello world'), 11))).toBe('hello world');
  });

  it('decodes multi-byte UTF-8 text correctly', () => {
    const text = 'héllo 🎉';
    expect(formatWsPayload(msg('text', b64(text), Buffer.byteLength(text)))).toBe(text);
  });

  it('pretty-prints text frames whose payload parses as JSON', () => {
    const payload = b64('{"a":1,"b":[2,3]}');
    expect(formatWsPayload(msg('text', payload, 17))).toBe(
      JSON.stringify({ a: 1, b: [2, 3] }, null, 2),
    );
  });

  it('does not re-escape the structural newlines introduced by JSON pretty-printing', () => {
    // If escaping ran *after* pretty-printing, the real newlines JSON.stringify
    // inserts for indentation would come out as literal "\n" text, destroying
    // the pretty-print.
    const payload = b64('{"a":1}');
    const result = formatWsPayload(msg('text', payload, 7));
    expect(result).toContain('\n');
    expect(result).not.toContain('\\n');
  });

  it('escapes control characters in non-JSON text frames', () => {
    const payload = b64('line1\x07line2');
    expect(formatWsPayload(msg('text', payload, 11))).toBe('line1\\aline2');
  });

  it('renders an empty text payload as an empty string, not "(no payload)"', () => {
    // A zero-length capture is a real (if uninteresting) frame, distinct from
    // payload === null.
    expect(formatWsPayload(msg('text', b64(''), 0))).toBe('');
  });

  it('caps very long text and says so explicitly, instead of cutting it silently', () => {
    const long = 'a'.repeat(20);
    const result = formatWsPayload(msg('text', b64(long), 20), 10);
    expect(result.startsWith('a'.repeat(10))).toBe(true);
    expect(result).toContain('hidden');
    expect(result).not.toBe(long);
  });

  it('does not cap text at or under the limit', () => {
    const exact = 'a'.repeat(10);
    expect(formatWsPayload(msg('text', b64(exact), 10), 10)).toBe(exact);
  });
});

describe('describeReplayOutcome', () => {
  function response(overrides: Partial<WsReplayResponse>): WsReplayResponse {
    return {
      sentCount: 1,
      frameCount: 1,
      sentAll: true,
      received: [],
      durationMs: 100,
      closeCode: null,
      stoppedBecause: 'close',
      ...overrides,
    };
  }

  it('treats "close" as success and reports the reply count', () => {
    const r = response({ stoppedBecause: 'close', received: [{ opcode: 'text', payload: '', offsetMs: 5 }] });
    const outcome = describeReplayOutcome(r);
    expect(outcome.level).toBe('success');
    expect(outcome.summary).toContain('1');
  });

  it('treats "idle" as a warning, never as success — replies may be incomplete', () => {
    // This is the central Task 12/13 invariant: idle means the replay gave up
    // after 500ms of silence, which happens routinely when a server is just
    // slow. It must not be reported the same way as a clean close.
    const r = response({ stoppedBecause: 'idle', received: [] });
    const outcome = describeReplayOutcome(r);
    expect(outcome.level).not.toBe('success');
    expect(outcome.level).toBe('warning');
    expect(outcome.summary.toLowerCase()).toMatch(/quiet|idle|incomplete/);
  });

  it('treats "timeout" as an error', () => {
    const r = response({ stoppedBecause: 'timeout', error: 'Replay timed out after 5000ms' });
    const outcome = describeReplayOutcome(r);
    expect(outcome.level).toBe('error');
    expect(outcome.summary).toContain('Replay timed out after 5000ms');
  });

  it('treats "error" as an error and surfaces the message', () => {
    const r = response({ stoppedBecause: 'error', error: 'ECONNRESET' });
    const outcome = describeReplayOutcome(r);
    expect(outcome.level).toBe('error');
    expect(outcome.summary).toContain('ECONNRESET');
  });

  it('surfaces closeCode when present, since it is the only signal distinguishing "closed" from "cut"', () => {
    const r = response({ stoppedBecause: 'close', closeCode: 1006 });
    const outcome = describeReplayOutcome(r);
    expect(outcome.summary).toContain('1006');
  });

  it('never reports an incomplete send as success, whatever ended the replay', () => {
    // The close path can end a replay mid-send: the server closes after the
    // first of three frames and `stoppedBecause` is still 'close'. Reporting
    // that as success is this project's dominant defect class — partial work
    // rendered green — in the one surface a person actually reads.
    const r = response({ stoppedBecause: 'close', sentCount: 1, frameCount: 3, sentAll: false, closeCode: 1000 });
    const outcome = describeReplayOutcome(r);
    expect(outcome.level).not.toBe('success');
    // How far it got has to be in the text, not just in the level: "something
    // went wrong" without "1 of 3 frames" leaves the reader unable to tell a
    // half-sent conversation from a connection that never opened.
    expect(outcome.summary).toContain('1');
    expect(outcome.summary).toContain('3');
    expect(outcome.summary.toLowerCase()).toMatch(/incomplete|only|before/);
    // The close code stays visible — it is what says whether the peer closed or
    // the connection was cut.
    expect(outcome.summary).toContain('1000');
  });

  it('does not demote a replay that had no frames to send', () => {
    // A "reconnect and listen" replay sent everything it was asked to send.
    const r = response({ stoppedBecause: 'close', sentCount: 0, frameCount: 0, sentAll: true });
    expect(describeReplayOutcome(r).level).toBe('success');
  });

  it('does not mention a close code when none was recorded', () => {
    const r = response({ stoppedBecause: 'close', closeCode: null });
    const outcome = describeReplayOutcome(r);
    expect(outcome.summary).not.toMatch(/close code/i);
  });
});

describe('mergeWsMessages', () => {
  function fixture(id: string, timestamp: number): UiWsMessage {
    return { id, request_id: 'r1', timestamp, direction: 'sent', opcode: 'text', payload: null, size: 0, truncated: 0 };
  }

  it('keeps a message that only exists locally (e.g. arrived live via SSE while the fetch was in flight)', () => {
    // If the initial GET's DB snapshot predates a frame that the SSE stream
    // already delivered, blindly overwriting local state with the fetch
    // result would silently drop that frame. It must survive the merge.
    const local = [fixture('live-only', 5)];
    const fetched = [fixture('a', 1), fixture('b', 2)];
    const merged = mergeWsMessages(local, fetched);
    expect(merged.map((m) => m.id)).toEqual(expect.arrayContaining(['live-only', 'a', 'b']));
    expect(merged).toHaveLength(3);
  });

  it('dedupes by id, preferring the fetched copy over the local one', () => {
    const local = [{ ...fixture('a', 1), size: 999 }];
    const fetched = [fixture('a', 1)];
    const merged = mergeWsMessages(local, fetched);
    expect(merged).toHaveLength(1);
    expect(merged[0].size).toBe(0);
  });

  it('sorts the merged result by timestamp', () => {
    const local = [fixture('late', 100)];
    const fetched = [fixture('mid', 50), fixture('early', 10)];
    const merged = mergeWsMessages(local, fetched);
    expect(merged.map((m) => m.id)).toEqual(['early', 'mid', 'late']);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(mergeWsMessages([], [])).toEqual([]);
  });
});

describe('parseThrottleInputs', () => {
  it('parses three valid numeric strings', () => {
    const result = parseThrottleInputs('500', '100', '200');
    expect(result).toEqual({ values: { downKbps: 500, upKbps: 100, latencyMs: 200 } });
  });

  it('accepts decimal and zero values', () => {
    const result = parseThrottleInputs('12.5', '0', '0');
    expect(result).toEqual({ values: { downKbps: 12.5, upKbps: 0, latencyMs: 0 } });
  });

  // Note: this documents that padded input is accepted, not that we trim it —
  // Number(' 500 ') is already 500, so this passes with or without a .trim()
  // call. The load-bearing whitespace case is the all-blank field below.
  it('accepts a field padded with whitespace', () => {
    const result = parseThrottleInputs(' 500 ', '100', '200');
    expect(result).toEqual({ values: { downKbps: 500, upKbps: 100, latencyMs: 200 } });
  });

  it('rejects a blank field rather than silently treating it as 0', () => {
    const result = parseThrottleInputs('', '100', '200');
    expect(result).toEqual({ error: 'downKbps is required' });
  });

  it('rejects a whitespace-only field the same as blank', () => {
    const result = parseThrottleInputs('500', '   ', '200');
    expect(result).toEqual({ error: 'upKbps is required' });
  });

  it('rejects a negative rate, matching the server\'s own rejection', () => {
    const result = parseThrottleInputs('500', '-5', '200');
    expect(result).toEqual({ error: 'upKbps must be a non-negative number' });
  });

  it('rejects a non-numeric value', () => {
    const result = parseThrottleInputs('500', '100', 'fast');
    expect(result).toEqual({ error: 'latencyMs must be a non-negative number' });
  });

  it('rejects Infinity, matching Number.isFinite on the server', () => {
    const result = parseThrottleInputs('Infinity', '100', '200');
    expect(result).toEqual({ error: 'downKbps must be a non-negative number' });
  });

  it('checks fields in down/up/latency order, reporting the first failure', () => {
    const result = parseThrottleInputs('-1', '-2', '-3');
    expect(result).toEqual({ error: 'downKbps must be a non-negative number' });
  });
});

describe('recordKind', () => {
  it('reports "websocket" only for the literal kind "websocket"', () => {
    expect(recordKind({ kind: 'websocket' })).toBe('websocket');
  });

  it('treats a legacy null kind (pre-migration row) as "http", not "unknown"', () => {
    expect(recordKind({ kind: null })).toBe('http');
  });

  it('treats a missing kind field as "http"', () => {
    expect(recordKind({})).toBe('http');
  });

  it('treats an explicit "http" kind as "http"', () => {
    expect(recordKind({ kind: 'http' })).toBe('http');
  });
});
