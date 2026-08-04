export interface RequestRecord {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  host: string;
  path: string;
  protocol: 'http' | 'https';
  request_headers: string;
  request_body: Buffer | null;
  request_size: number;
  status: number | null;
  response_headers: string | null;
  response_body: Buffer | null;
  response_size: number;
  duration: number | null;
  content_type: string | null;
  truncated: number;
  kind?: RequestKind;
  /**
   * Wire protocol negotiated with the **client**; independent of {@link RequestRecord.protocol}
   * (the URL scheme) and of `origin_protocol`, which covers the other hop of the exchange.
   * `null`/absent means genuinely unknown, never a silent default of `'http/1.1'`.
   */
  client_protocol?: WireProtocol | null;
  /**
   * The wire protocol negotiated with the **origin** for this exchange. See
   * `client_protocol` for why this is a separate field rather than reusing
   * `protocol`, and why `null`/absent means unknown rather than a guess.
   */
  origin_protocol?: WireProtocol | null;
}

export type RequestKind = 'http' | 'websocket';

/**
 * Wire protocol actually spoken on one hop, distinct from {@link RequestRecord.protocol}
 * (the URL scheme). Named to match `NegotiatedProtocol` in `src/server/upstream.ts`;
 * kept separate since this file (shared with browser code) can't use `node:http2`.
 */
export type WireProtocol = 'http/1.1' | 'h2';

export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

export interface WebSocketMessage {
  id: string;
  request_id: string;
  timestamp: number;
  /** 'sent' = client→server, 'received' = server→client */
  direction: 'sent' | 'received';
  opcode: WsOpcode;
  payload: Buffer | null;
  size: number;
  truncated: number;
}

export interface ThrottleProfile {
  downKbps: number;
  upKbps: number;
  latencyMs: number;
}

export interface ThrottleSettings extends ThrottleProfile {
  enabled: boolean;
}

export const DEFAULT_THROTTLE: ThrottleSettings = {
  enabled: false,
  downKbps: 0,
  upKbps: 0,
  latencyMs: 0,
};

export interface Config {
  proxyPort: number;
  uiPort: number;
  dbPath: string;
  maxAge: number;
  maxDbSize: number;
  maxBodySize: number;
  certCacheSize: number;
  throttle: ThrottleSettings;
}

export const DEFAULT_CONFIG: Config = {
  proxyPort: 8080,
  uiPort: 8081,
  dbPath: '~/.laurel-proxy/data.db',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  maxDbSize: 500 * 1024 * 1024,
  maxBodySize: 1 * 1024 * 1024,
  certCacheSize: 500,
  throttle: DEFAULT_THROTTLE,
};

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProxyStatus {
  running: boolean;
  proxyPort: number;
  uiPort: number;
  requestCount: number;
  dbSizeBytes: number;
}

export interface RequestFilter {
  host?: string;
  /**
   * 'http' matches a NULL `kind` too: rows predating the migration, or written
   * around `bindRecord`, read back NULL rather than 'http'; excluding NULL
   * from both filters would hide such a row only when filtered.
   */
  kind?: RequestKind;
  /**
   * Exact match against `client_protocol`/`origin_protocol`, unlike `kind`'s
   * NULL-tolerant match: no current write path produces a `null` protocol,
   * so such a row is an anomaly, not folded into a known value.
   */
  clientProtocol?: WireProtocol;
  originProtocol?: WireProtocol;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  method?: string;
  content_type?: string;
  search?: string;
  since?: number;
  until?: number;
  durationMin?: number;
  limit?: number;
  offset?: number;
}

export interface ReplayRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[]>;
  body?: string;
}

export interface ReplayResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  duration: number;
  size: number;
}

export interface WsReplayFrame {
  opcode: 'text' | 'binary';
  /** base64-encoded */
  payload: string;
  /** milliseconds to wait after the previous frame */
  delayMs: number;
}

export interface WsReplayRequest {
  url: string;
  frames: WsReplayFrame[];
  timeoutMs?: number;
}

/**
 * Why a replay stopped. A WebSocket has no response boundary, so this is the only
 * signal distinguishing "the server finished" from "we gave up waiting": `idle`
 * may just mean the server was slower to answer than the quiet period allows.
 */
export type WsReplayStopReason = 'idle' | 'close' | 'timeout' | 'error';

export interface WsReplayResponse {
  /** Frames handed to the socket before the replay ended. */
  sentCount: number;
  /** Frames the replay was asked to send, so `sentCount` has a denominator. */
  frameCount: number;
  /**
   * Whether every requested frame actually went out — `stoppedBecause` alone can't tell,
   * since closing after 1 of 3 frames also reports `'close'`, just like a
   * clean run. Consult this before calling a replay a success.
   */
  sentAll: boolean;
  /**
   * Server frames, in arrival order. `payload` is base64 for both opcodes, matching
   * `GET /api/requests/:id/messages`. `offsetMs` is measured from the
   * start of the replay, so it includes connection setup.
   */
  received: { opcode: 'text' | 'binary'; payload: string; offsetMs: number }[];
  durationMs: number;
  /** The close code, when the connection closed before the replay ended. */
  closeCode: number | null;
  stoppedBecause: WsReplayStopReason;
  /** Present only when the replay failed or timed out. */
  error?: string;
}
