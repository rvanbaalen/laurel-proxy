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

export interface WsReplayResponse {
  /** Frames handed to the socket before the replay ended. */
  sentCount: number;
  /**
   * Server frames, in arrival order. `payload` is base64 for both opcodes,
   * matching `GET /api/requests/:id/messages`. `offsetMs` is measured from the
   * start of the replay, so it includes connection setup.
   */
  received: { opcode: 'text' | 'binary'; payload: string; offsetMs: number }[];
  durationMs: number;
  /** The close code, when the connection closed before the replay ended. */
  closeCode: number | null;
  /** Present only when the replay failed or timed out. */
  error?: string;
}
