import { describe, it, expect } from 'vitest';
import { WsFrameDecoder, MAX_PAYLOAD_BYTES } from './ws-frames.js';
import { encodeFrame } from '../../tests/helpers/ws-frames.js';

/**
 * Builds frames `encodeFrame` deliberately cannot: fragments (fin=0,
 * continuation opcode), RSV bits set, reserved opcodes, and headers whose
 * declared length does not match the bytes that follow. The shared helper in
 * `tests/helpers/` only ever produces *valid* frames, because Tasks 9 and 12
 * use it to drive real echo servers.
 */
function rawFrame(opts: {
  opcode: number;
  fin?: boolean;
  rsv?: number;
  payload?: Buffer;
  maskKey?: Buffer;
  /** Force a wider length form than the payload needs, or declare a length that lies. */
  declaredLength?: number | bigint;
}): Buffer {
  const payload = opts.payload ?? Buffer.alloc(0);
  const fin = opts.fin ?? true;
  const declared = opts.declaredLength ?? payload.length;
  const header: number[] = [(fin ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opts.opcode];
  const maskBit = opts.maskKey ? 0x80 : 0;

  if (typeof declared === 'number' && declared < 126) {
    header.push(maskBit | declared);
  } else if (typeof declared === 'number' && declared < 65536) {
    header.push(maskBit | 126, declared >> 8, declared & 0xff);
  } else {
    header.push(maskBit | 127);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(declared));
    header.push(...len);
  }

  if (!opts.maskKey) return Buffer.concat([Buffer.from(header), payload]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= opts.maskKey[i % 4];
  return Buffer.concat([Buffer.from(header), opts.maskKey, masked]);
}

describe('WsFrameDecoder', () => {
  it('decodes a single unmasked text frame', () => {
    const d = new WsFrameDecoder();
    const out = d.push(encodeFrame('text', Buffer.from('hello')));
    expect(out).toHaveLength(1);
    expect(out[0].opcode).toBe('text');
    expect(out[0].payload.toString()).toBe('hello');
    expect(d.isFailed).toBe(false);
  });

  it('decodes a masked client frame', () => {
    const d = new WsFrameDecoder();
    const frame = encodeFrame('text', Buffer.from('masked!'), true);
    // Guard the helper: if the wire bytes matched the plaintext, a decoder that
    // never unmasks would pass the assertion below for the wrong reason.
    expect(frame.subarray(6).toString()).not.toBe('masked!');
    const out = d.push(frame);
    expect(out[0].payload.toString()).toBe('masked!');
  });

  it('decodes a 16-bit length payload', () => {
    const payload = Buffer.alloc(300, 'a');
    const out = new WsFrameDecoder().push(encodeFrame('binary', payload));
    expect(out[0].payload.length).toBe(300);
    expect(out[0].opcode).toBe('binary');
  });

  it('decodes a 64-bit length payload', () => {
    const payload = Buffer.alloc(70_000, 'b');
    const out = new WsFrameDecoder().push(encodeFrame('binary', payload));
    expect(out[0].payload.length).toBe(70_000);
  });

  it('decodes every length form, masked and unmasked, byte-exactly', () => {
    // 125/126 straddle the 7-bit boundary and 65535/65536 the 16-bit one, so
    // this pins the header arithmetic for all three length encodings.
    for (const length of [0, 1, 125, 126, 127, 65535, 65536, 70_000]) {
      for (const mask of [false, true]) {
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i++) payload[i] = (i * 31 + 7) & 0xff;
        const out = new WsFrameDecoder().push(encodeFrame('binary', payload, mask));
        expect(out, `length=${length} mask=${mask}`).toHaveLength(1);
        expect(out[0].payload.equals(payload), `length=${length} mask=${mask}`).toBe(true);
      }
    }
  });

  it('reassembles continuation frames into one message', () => {
    const d = new WsFrameDecoder();
    // fin=0 text, then fin=0 continuation, then fin=1 continuation
    const first = Buffer.concat([Buffer.from([0x01, 0x03]), Buffer.from('abc')]);
    const middle = Buffer.concat([Buffer.from([0x00, 0x03]), Buffer.from('def')]);
    const last = Buffer.concat([Buffer.from([0x80, 0x03]), Buffer.from('ghi')]);
    expect(d.push(first)).toHaveLength(0);
    expect(d.push(middle)).toHaveLength(0);
    const out = d.push(last);
    expect(out).toHaveLength(1);
    expect(out[0].payload.toString()).toBe('abcdefghi');
    expect(out[0].opcode).toBe('text');
  });

  it('reassembles masked binary fragments with a different key per fragment', () => {
    const d = new WsFrameDecoder();
    const key1 = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const key2 = Buffer.from([0xa5, 0x5a, 0x01, 0xfe]);
    expect(
      d.push(rawFrame({ opcode: 0x2, fin: false, payload: Buffer.from('front-'), maskKey: key1 })),
    ).toHaveLength(0);
    const out = d.push(rawFrame({ opcode: 0x0, fin: true, payload: Buffer.from('back'), maskKey: key2 }));
    expect(out).toHaveLength(1);
    expect(out[0].opcode).toBe('binary');
    expect(out[0].payload.toString()).toBe('front-back');
  });

  it('carries the opcode of the first fragment, not the continuation', () => {
    const d = new WsFrameDecoder();
    d.push(rawFrame({ opcode: 0x2, fin: false, payload: Buffer.from([0x01]) }));
    const out = d.push(rawFrame({ opcode: 0x0, fin: true, payload: Buffer.from([0x02]) }));
    expect(out[0].opcode).toBe('binary');
  });

  it('decodes multiple frames arriving in one chunk', () => {
    const d = new WsFrameDecoder();
    const out = d.push(Buffer.concat([
      encodeFrame('text', Buffer.from('one')),
      encodeFrame('text', Buffer.from('two')),
    ]));
    expect(out.map((m) => m.payload.toString())).toEqual(['one', 'two']);
  });

  it('waits for the rest of a frame split across chunks', () => {
    const d = new WsFrameDecoder();
    const frame = encodeFrame('text', Buffer.from('split-me'));
    expect(d.push(frame.subarray(0, 3))).toHaveLength(0);
    const out = d.push(frame.subarray(3));
    expect(out[0].payload.toString()).toBe('split-me');
  });

  it('decodes correctly for every possible split point of a masked frame', () => {
    // A masked 16-bit-length frame has the longest header (2 + 2 + 4 = 8 bytes),
    // so this exercises every partial-header state the decoder can be left in.
    const payload = Buffer.alloc(300, 0xc3);
    const frame = encodeFrame('binary', payload, true);
    for (let split = 0; split <= frame.length; split++) {
      const d = new WsFrameDecoder();
      const head = d.push(frame.subarray(0, split));
      const tail = d.push(frame.subarray(split));
      const all = [...head, ...tail];
      expect(all, `split=${split}`).toHaveLength(1);
      expect(all[0].payload.equals(payload), `split=${split}`).toBe(true);
    }
  });

  it('decodes a stream fed one byte at a time', () => {
    const d = new WsFrameDecoder();
    const stream = Buffer.concat([
      encodeFrame('text', Buffer.from('alpha'), true),
      encodeFrame('ping', Buffer.alloc(0)),
      encodeFrame('binary', Buffer.alloc(200, 0x5a)),
    ]);
    const out = [];
    for (const byte of stream) out.push(...d.push(Buffer.from([byte])));
    expect(out.map((m) => m.opcode)).toEqual(['text', 'ping', 'binary']);
    expect(out[0].payload.toString()).toBe('alpha');
    expect(out[2].payload.length).toBe(200);
  });

  it('returns nothing for an empty chunk', () => {
    const d = new WsFrameDecoder();
    expect(d.push(Buffer.alloc(0))).toHaveLength(0);
    expect(d.isFailed).toBe(false);
  });

  it('decodes control frames', () => {
    const d = new WsFrameDecoder();
    expect(d.push(encodeFrame('ping', Buffer.alloc(0)))[0].opcode).toBe('ping');
    expect(d.push(encodeFrame('pong', Buffer.alloc(0)))[0].opcode).toBe('pong');
    expect(d.push(encodeFrame('close', Buffer.alloc(0)))[0].opcode).toBe('close');
  });

  it('decodes zero-length and payload-carrying control frames', () => {
    const d = new WsFrameDecoder();
    const empty = d.push(encodeFrame('ping', Buffer.alloc(0)));
    expect(empty[0].payload).toHaveLength(0);
    // Close with status 1000 + reason, masked as a client would send it.
    const body = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('bye')]);
    const close = d.push(encodeFrame('close', body, true));
    expect(close[0].opcode).toBe('close');
    expect(close[0].payload.equals(body)).toBe(true);
  });

  it('decodes a zero-length data frame', () => {
    const d = new WsFrameDecoder();
    const out = d.push(encodeFrame('text', Buffer.alloc(0)));
    expect(out).toHaveLength(1);
    expect(out[0].opcode).toBe('text');
    expect(out[0].payload).toHaveLength(0);
  });

  it('accepts a 125-byte control payload but rejects 126', () => {
    const ok = new WsFrameDecoder();
    expect(ok.push(encodeFrame('ping', Buffer.alloc(125)))).toHaveLength(1);
    expect(ok.isFailed).toBe(false);

    const bad = new WsFrameDecoder();
    bad.push(encodeFrame('ping', Buffer.alloc(126)));
    expect(bad.isFailed).toBe(true);
  });

  it('does not let a control frame interrupt fragment reassembly', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.concat([Buffer.from([0x01, 0x03]), Buffer.from('abc')]));
    const ping = d.push(encodeFrame('ping', Buffer.alloc(0)));
    expect(ping).toHaveLength(1);
    expect(ping[0].opcode).toBe('ping');
    const out = d.push(Buffer.concat([Buffer.from([0x80, 0x03]), Buffer.from('def')]));
    expect(out[0].payload.toString()).toBe('abcdef');
  });

  it('fails on a reserved opcode and stops decoding', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.from([0x83, 0x00])); // opcode 0x3 is reserved
    expect(d.isFailed).toBe(true);
    expect(d.push(encodeFrame('text', Buffer.from('x')))).toHaveLength(0);
  });

  it('fails on a reserved control opcode', () => {
    const d = new WsFrameDecoder();
    d.push(rawFrame({ opcode: 0xb }));
    expect(d.isFailed).toBe(true);
  });

  it('fails on an oversized control frame', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.concat([Buffer.from([0x89, 0x7e, 0x01, 0x00]), Buffer.alloc(256)]));
    expect(d.isFailed).toBe(true);
  });

  it('rejects an oversized control frame from the header alone', () => {
    // The length violation is knowable before the payload arrives; buffering
    // 64 KiB of a frame already known to be illegal would be pointless.
    const d = new WsFrameDecoder();
    d.push(Buffer.from([0x89, 0x7e, 0xff, 0xff]));
    expect(d.isFailed).toBe(true);
  });

  it('fails on a fragmented control frame', () => {
    const d = new WsFrameDecoder();
    d.push(Buffer.from([0x09, 0x00])); // ping with fin=0
    expect(d.isFailed).toBe(true);
  });

  it('fails on a continuation frame with no fragment in progress', () => {
    const d = new WsFrameDecoder();
    d.push(rawFrame({ opcode: 0x0, fin: true, payload: Buffer.from('orphan') }));
    expect(d.isFailed).toBe(true);
  });

  it('fails on a new data frame arriving mid-fragment', () => {
    const d = new WsFrameDecoder();
    d.push(rawFrame({ opcode: 0x1, fin: false, payload: Buffer.from('abc') }));
    d.push(encodeFrame('text', Buffer.from('interleaved')));
    expect(d.isFailed).toBe(true);
  });

  it('returns messages decoded before an invalid frame in the same chunk', () => {
    const d = new WsFrameDecoder();
    const out = d.push(Buffer.concat([
      encodeFrame('text', Buffer.from('ok')),
      Buffer.from([0x83, 0x00]),
      encodeFrame('text', Buffer.from('never')),
    ]));
    expect(out.map((m) => m.payload.toString())).toEqual(['ok']);
    expect(d.isFailed).toBe(true);
  });

  describe('RSV bits', () => {
    // The relay strips Sec-WebSocket-Extensions so permessage-deflate cannot be
    // negotiated and payloads stay plaintext. A set RSV bit means that
    // assumption broke and the bytes are compressed — recording them verbatim
    // would produce a recording that silently lies.
    for (const [name, rsv] of [['RSV1', 0b100], ['RSV2', 0b010], ['RSV3', 0b001]] as const) {
      it(`fails when ${name} is set`, () => {
        const d = new WsFrameDecoder();
        d.push(rawFrame({ opcode: 0x1, rsv, payload: Buffer.from('deflated?') }));
        expect(d.isFailed).toBe(true);
      });
    }

    it('fails on a set RSV bit before buffering the payload', () => {
      const d = new WsFrameDecoder();
      d.push(Buffer.from([0xc1, 0x7e, 0xff, 0xff])); // RSV1 + text, declares 64 KiB
      expect(d.isFailed).toBe(true);
    });
  });

  describe('payload length cap', () => {
    it('fails on a 64-bit length above the cap without buffering the payload', () => {
      const d = new WsFrameDecoder();
      // Header only: 10 bytes in, no payload will ever follow.
      d.push(rawFrame({ opcode: 0x2, declaredLength: BigInt(MAX_PAYLOAD_BYTES) + 1n }));
      expect(d.isFailed).toBe(true);
    });

    it('fails on an absurd 64-bit length rather than buffering forever', () => {
      const d = new WsFrameDecoder();
      d.push(rawFrame({ opcode: 0x2, declaredLength: 0x7fff_ffff_ffff_ffffn }));
      expect(d.isFailed).toBe(true);
    });

    it('still accepts a frame declaring exactly the cap', () => {
      const d = new WsFrameDecoder();
      const out = d.push(rawFrame({ opcode: 0x2, declaredLength: BigInt(MAX_PAYLOAD_BYTES) }));
      expect(out).toHaveLength(0);
      expect(d.isFailed).toBe(false);
    });

    it('caps the total size of a reassembled fragmented message', () => {
      // Individually legal fragments must not be able to grow the reassembly
      // buffer without bound.
      const d = new WsFrameDecoder();
      d.push(rawFrame({ opcode: 0x1, fin: false, payload: Buffer.from('x') }));
      d.push(rawFrame({ opcode: 0x0, fin: false, declaredLength: BigInt(MAX_PAYLOAD_BYTES) }));
      expect(d.isFailed).toBe(true);
    });

    it('allows a fragmented message that totals exactly the cap', () => {
      const d = new WsFrameDecoder();
      d.push(rawFrame({ opcode: 0x1, fin: false, payload: Buffer.from('x') }));
      d.push(rawFrame({ opcode: 0x0, fin: false, declaredLength: BigInt(MAX_PAYLOAD_BYTES - 1) }));
      expect(d.isFailed).toBe(false);
    });
  });

  describe('buffer ownership', () => {
    it('does not mutate the chunk it was given', () => {
      const d = new WsFrameDecoder();
      const chunk = encodeFrame('text', Buffer.from('do-not-touch'), true);
      const pristine = Buffer.from(chunk);
      d.push(chunk);
      expect(chunk.equals(pristine)).toBe(true);
    });

    it('returns payloads that are copies, not views into the caller chunk', () => {
      const d = new WsFrameDecoder();
      const chunk = encodeFrame('text', Buffer.from('abc'));
      const out = d.push(chunk);
      out[0].payload[0] = 0x7a;
      expect(chunk.subarray(2).toString()).toBe('abc');
    });

    it('does not retain the caller chunk across pushes', () => {
      // A caller that reuses its read buffer after push() returns must not be
      // able to corrupt a partially decoded frame.
      const d = new WsFrameDecoder();
      const frame = encodeFrame('text', Buffer.from('split-me'), true);
      const first = Buffer.from(frame.subarray(0, 5));
      expect(d.push(first)).toHaveLength(0);
      first.fill(0);
      const out = d.push(Buffer.from(frame.subarray(5)));
      expect(out).toHaveLength(1);
      expect(out[0].payload.toString()).toBe('split-me');
    });
  });
});
