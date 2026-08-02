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
}

export type RequestKind = 'http' | 'websocket';

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
   * 'http' matches a NULL `kind` too: the column arrived by migration, and a row
   * that predates it — or one written around `bindRecord` — reads back NULL
   * rather than 'http'. Excluding those from both filters would make a row
   * visible unfiltered and invisible filtered, which is worse than either answer.
   */
  kind?: RequestKind;
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
 * Why a replay stopped. A WebSocket has no response boundary, so this is the
 * only thing that distinguishes "the server finished" from "we stopped waiting":
 * `idle` means the quiet period elapsed, which may simply mean the server was
 * slower to answer than the quiet period allows.
 */
export type WsReplayStopReason = 'idle' | 'close' | 'timeout' | 'error';

export interface WsReplayResponse {
  /** Frames handed to the socket before the replay ended. */
  sentCount: number;
  /** Frames the replay was asked to send, so `sentCount` has a denominator. */
  frameCount: number;
  /**
   * Whether every requested frame went out.
   *
   * `stoppedBecause` cannot answer this on its own: a server that closes after
   * the first of three frames stops the replay with `'close'` and a `sentCount`
   * of 1, which is indistinguishable from a clean run unless the caller
   * re-counts the frames it passed in. Anything reporting a verdict on a replay
   * must consult this before calling the result a success — a partial send
   * reported as success is the failure this field exists to make impossible.
   */
  sentAll: boolean;
  /**
   * Server frames, in arrival order. `payload` is base64 for both opcodes,
   * matching `GET /api/requests/:id/messages`. `offsetMs` is measured from the
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
