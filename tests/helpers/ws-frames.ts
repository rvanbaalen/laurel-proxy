// ws-frames.ts owns WsOpcode at this point; a later task moves the definition to
// shared/types.ts and re-exports it from there, so this import keeps working.
import type { WsOpcode } from '../../src/server/ws-frames.js';

const OPCODE_BYTES: Record<WsOpcode, number> = {
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/**
 * Build a valid RFC 6455 frame (fin=1, no RSV bits, single unfragmented frame).
 * Test scaffolding only — the proxy relay passes bytes through untouched and
 * never encodes, so this must not live in `src/`.
 */
export function encodeFrame(opcode: WsOpcode, payload: Buffer, mask = false): Buffer {
  const header: number[] = [0x80 | OPCODE_BYTES[opcode]];
  const maskBit = mask ? 0x80 : 0x00;

  if (payload.length < 126) {
    header.push(maskBit | payload.length);
  } else if (payload.length < 65536) {
    header.push(maskBit | 126, payload.length >> 8, payload.length & 0xff);
  } else {
    header.push(maskBit | 127);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    header.push(...len);
  }

  if (!mask) return Buffer.concat([Buffer.from(header), payload]);

  // Every key byte is forced non-zero so masking always changes every payload
  // byte. A randomly drawn 0x00 byte would leave that quarter of the payload
  // identical to the plaintext, which could let a decoder that skips unmasking
  // pass a test by luck.
  const key = Buffer.from([
    1 + Math.floor(Math.random() * 255), 1 + Math.floor(Math.random() * 255),
    1 + Math.floor(Math.random() * 255), 1 + Math.floor(Math.random() * 255),
  ]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(header), key, masked]);
}
