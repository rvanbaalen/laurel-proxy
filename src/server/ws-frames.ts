export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

export interface WsMessage {
  opcode: WsOpcode;
  payload: Buffer;
}

const OPCODES: Record<number, WsOpcode | undefined> = {
  0x1: 'text',
  0x2: 'binary',
  0x8: 'close',
  0x9: 'ping',
  0xa: 'pong',
};

const CONTINUATION = 0x0;
const FIRST_CONTROL_OPCODE = 0x8;
const MAX_CONTROL_PAYLOAD = 125;

/**
 * Upper bound on a single frame's payload and on a reassembled fragmented
 * message. The wire format allows a 63-bit length, so a corrupt or hostile
 * length field would otherwise make the decoder buffer bytes that never
 * arrive — unbounded growth in a long-lived proxy process.
 *
 * 32 MiB is ~32x the 1 MiB default max-message-size that common WebSocket
 * stacks ship with (ws, Socket.IO), so no realistic frame trips it, while
 * being five orders of magnitude below what the length field permits and
 * small enough that even dozens of adversarial connections cannot exhaust a
 * default Node heap. Exceeding it fails the decoder rather than buffering;
 * because the decoder is a passive observer the relay keeps forwarding bytes
 * untouched and only the recording degrades.
 */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

const EMPTY = Buffer.alloc(0);

/** A decoded frame plus the absolute offset one past its last byte. */
type FrameResult = 'incomplete' | 'invalid' | { message: WsMessage | null; end: number };

/**
 * Incremental RFC 6455 frame decoder. Passive: it observes bytes and never
 * re-encodes them, so a decoding failure degrades recording without ever
 * corrupting relayed traffic.
 *
 * Buffer ownership: `this.buffer` is treated as read-only (payloads are copied
 * out before unmasking) and never holds a reference into a chunk the caller
 * gave us, so a caller that reuses its read buffer cannot corrupt a
 * half-decoded frame and we never pin a whole allocation slab.
 */
export class WsFrameDecoder {
  private buffer: Buffer = EMPTY;
  private fragments: Buffer[] = [];
  private fragmentOpcode: WsOpcode | null = null;
  private fragmentBytes = 0;
  private failed = false;

  get isFailed(): boolean {
    return this.failed;
  }

  push(chunk: Buffer): WsMessage[] {
    if (this.failed) return [];
    const buf = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const messages: WsMessage[] = [];
    let pos = 0;
    for (;;) {
      const frame = this.readFrame(buf, pos);
      if (frame === 'incomplete') break;
      if (frame === 'invalid') {
        this.failed = true;
        this.buffer = EMPTY;
        this.resetFragments();
        return messages;
      }
      pos = frame.end;
      if (frame.message) messages.push(frame.message);
    }
    // Copy rather than keep a view: `buf` may be the caller's chunk.
    this.buffer = pos === buf.length ? EMPTY : Buffer.from(buf.subarray(pos));
    return messages;
  }

  private resetFragments(): void {
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
  }

  private readFrame(buf: Buffer, start: number): FrameResult {
    if (buf.length - start < 2) return 'incomplete';

    const fin = (buf[start] & 0x80) !== 0;
    // The relay strips Sec-WebSocket-Extensions so permessage-deflate can never
    // be negotiated. A set RSV bit means that assumption broke and the payload
    // is compressed, which we must not record as if it were plaintext.
    if ((buf[start] & 0x70) !== 0) return 'invalid';
    const rawOpcode = buf[start] & 0x0f;
    const masked = (buf[start + 1] & 0x80) !== 0;
    const lenBits = buf[start + 1] & 0x7f;

    let offset = start + 2;
    let payloadLength: number;
    if (lenBits < 126) {
      payloadLength = lenBits;
    } else if (lenBits === 126) {
      if (buf.length < offset + 2) return 'incomplete';
      payloadLength = buf.readUInt16BE(offset);
      offset += 2;
    } else {
      if (buf.length < offset + 8) return 'incomplete';
      // Compared as BigInt: converting first would be lossy above 2^53.
      // The 7-bit and 16-bit forms cannot exceed the cap, so this is the only
      // length form that needs the check.
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD_BYTES)) return 'invalid';
      payloadLength = Number(big);
      offset += 8;
    }

    // Everything knowable from the header is validated before we wait for the
    // payload, so an already-illegal frame never causes buffering.
    const isControl = rawOpcode >= FIRST_CONTROL_OPCODE;
    const isContinuation = rawOpcode === CONTINUATION;
    // For a continuation the message opcode comes from the frame that opened
    // the fragment; a null there means this continuation is orphaned.
    const opcode = isContinuation ? this.fragmentOpcode : (OPCODES[rawOpcode] ?? null);
    if (opcode === null) return 'invalid';
    // Control frames are never fragmented and cap at 125 bytes.
    if (isControl && (!fin || payloadLength > MAX_CONTROL_PAYLOAD)) return 'invalid';
    // A data frame may not interleave with a fragmented message in progress.
    if (!isControl && !isContinuation && this.fragmentOpcode !== null) return 'invalid';
    // Individually legal fragments must not grow the reassembly buffer without bound.
    if (isContinuation && this.fragmentBytes + payloadLength > MAX_PAYLOAD_BYTES) return 'invalid';

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return 'incomplete';
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLength) return 'incomplete';

    // Copied before unmasking: `buf` may be the caller's chunk, and the payload
    // outlives this call as part of a recorded message.
    const payload = Buffer.from(buf.subarray(offset, offset + payloadLength));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    const end = offset + payloadLength;

    if (isControl) return { message: { opcode, payload }, end };

    if (isContinuation) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (!fin) return { message: null, end };
      const full = Buffer.concat(this.fragments);
      this.resetFragments();
      return { message: { opcode, payload: full }, end };
    }

    if (fin) return { message: { opcode, payload }, end };

    this.fragmentOpcode = opcode;
    this.fragments = [payload];
    this.fragmentBytes = payload.length;
    return { message: null, end };
  }
}
