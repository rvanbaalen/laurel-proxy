import { useState, useEffect, useCallback } from 'react';

export interface RequestRecord {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  host: string;
  path: string;
  protocol: string;
  request_headers: string;
  request_body: string | null;
  request_size: number;
  status: number | null;
  response_headers: string | null;
  response_body: string | null;
  response_size: number;
  duration: number | null;
  content_type: string | null;
  truncated: number;
  kind?: 'http' | 'websocket';
}

export interface ProxyStatus {
  running: boolean;
  proxyPort: number;
  requestCount: number;
  dbSizeBytes: number;
  hostname?: string;
}

export interface PaginatedResponse {
  data: RequestRecord[];
  total: number;
  limit: number;
  offset: number;
}

const API_BASE = '/api';

export async function fetchRequests(params: Record<string, string> = {}): Promise<PaginatedResponse> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/requests?${query}`);
  return res.json();
}

export async function fetchRequest(id: string): Promise<RequestRecord> {
  const res = await fetch(`${API_BASE}/requests/${id}`);
  return res.json();
}

export async function fetchStatus(): Promise<ProxyStatus> {
  const res = await fetch(`${API_BASE}/status`);
  return res.json();
}

export async function clearRequests(): Promise<void> {
  await fetch(`${API_BASE}/requests`, { method: 'DELETE' });
}

export async function startProxy(): Promise<void> {
  await fetch(`${API_BASE}/proxy/start`, { method: 'POST' });
}

export async function stopProxy(): Promise<void> {
  await fetch(`${API_BASE}/proxy/stop`, { method: 'POST' });
}

export async function fetchSystemProxyStatus(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/system-proxy`);
  const data = await res.json();
  return data.enabled;
}

export async function enableSystemProxy(): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/system-proxy/enable`, { method: 'POST' });
  return res.json();
}

export async function disableSystemProxy(): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/system-proxy/disable`, { method: 'POST' });
  return res.json();
}

export interface ReplayRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ReplayResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  duration: number;
  size: number;
}

export async function replayRequest(request: ReplayRequest): Promise<ReplayResponse> {
  const res = await fetch(`${API_BASE}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Replay failed');
  }
  return res.json();
}

export interface ThrottleState {
  settings: { enabled: boolean; downKbps: number; upKbps: number; latencyMs: number };
  presets: Record<string, { downKbps: number; upKbps: number; latencyMs: number }>;
}

export async function getThrottle(): Promise<ThrottleState> {
  const res = await fetch(`${API_BASE}/throttle`);
  if (!res.ok) throw new Error('Failed to load throttle settings');
  return res.json();
}

export async function setThrottle(
  payload: { preset: string } | { enabled: boolean; downKbps?: number; upKbps?: number; latencyMs?: number },
): Promise<ThrottleState['settings']> {
  const res = await fetch(`${API_BASE}/throttle`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update throttle');
  return (await res.json()).settings;
}

/**
 * Which dropdown option the current throttle settings correspond to.
 *
 * - 'unknown' when state hasn't loaded yet, or the fetch failed. This must NOT
 *   collapse into 'off': claiming "disabled" when the real state is unknown
 *   misreports it, exactly as misreporting a custom rate as 'off' would.
 * - 'off' when throttling is confirmed disabled.
 * - a preset key only when all three values (down/up/latency) match exactly —
 *   a partial match (e.g. right downKbps, wrong latencyMs) is NOT a preset.
 * - 'custom' when enabled but no preset matches exactly. This is reachable
 *   because the CLI/API accept arbitrary --down/--up/--latency values.
 */
export interface ThrottleFormValues {
  downKbps: number;
  upKbps: number;
  latencyMs: number;
}

/**
 * Parses the three text inputs of the custom-throttle popover into a
 * validated payload, mirroring the server's `validateThrottleSettings`
 * (`src/server/throttle.ts`): each field must be finite and non-negative.
 * This is a client-side convenience only — it lets the popover reject an
 * obviously-bad value (blank, negative, "fast") without a round trip, but it
 * is not the source of truth. The server's own 400/500 must still be
 * surfaced to the user even when this parse passes, since persistence can
 * fail for reasons this function can't see.
 */
export function parseThrottleInputs(
  downKbps: string,
  upKbps: string,
  latencyMs: string,
): { values: ThrottleFormValues } | { error: string } {
  const entries: Array<[keyof ThrottleFormValues, string]> = [
    ['downKbps', downKbps],
    ['upKbps', upKbps],
    ['latencyMs', latencyMs],
  ];
  const values = {} as ThrottleFormValues;
  for (const [key, raw] of entries) {
    const trimmed = raw.trim();
    if (trimmed === '') return { error: `${key} is required` };
    const n = Number(trimmed);
    // Number.isFinite rejects NaN/±Infinity and, since `trimmed` is already a
    // string, also anything Number() can't parse ('fast' -> NaN). Matches the
    // server's own check exactly.
    if (!Number.isFinite(n) || n < 0) return { error: `${key} must be a non-negative number` };
    values[key] = n;
  }
  return { values };
}

export function activePreset(state: ThrottleState | null): string {
  if (!state) return 'unknown';
  if (!state.settings.enabled) return 'off';
  const { downKbps, upKbps, latencyMs } = state.settings;
  const match = Object.entries(state.presets).find(
    ([, p]) => p.downKbps === downKbps && p.upKbps === upKbps && p.latencyMs === latencyMs,
  );
  return match ? match[0] : 'custom';
}

/**
 * Loads throttle state and polls the server so the display stays accurate
 * even when throttling was changed from elsewhere (e.g. the `throttle` CLI
 * command) while the UI is open. Mirrors the polling pattern `Controls`
 * already uses for proxy status. Independent components (the toolbar pill
 * and the traffic view's duration note) each call this on their own rather
 * than threading throttle state through `App` — the endpoint is cheap and
 * this avoids adding shared/global state for a single small feature.
 */
export function useThrottle(pollMs = 5000): { throttle: ThrottleState | null; refresh: () => void } {
  const [throttle, setThrottleState] = useState<ThrottleState | null>(null);

  const refresh = useCallback(() => {
    getThrottle().then(setThrottleState).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { throttle, refresh };
}

export interface SSEState {
  requests: RequestRecord[];
  statusEvent: { running: boolean; proxyPort: number } | null;
  clearLocal: () => void;
}

export function useSSE(maxItems = 500): SSEState {
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [statusEvent, setStatusEvent] = useState<SSEState['statusEvent']>(null);
  const clearLocal = () => setRequests([]);

  useEffect(() => {
    let cancelled = false;

    // Load existing traffic from the database first
    fetchRequests({ limit: String(maxItems) }).then((result) => {
      if (!cancelled) {
        setRequests(result.data);
      }
    }).catch(() => {
      // Ignore fetch errors — SSE will still work
    });

    const es = new EventSource(`${API_BASE}/events`);

    es.addEventListener('request', (event) => {
      const record: RequestRecord = JSON.parse(event.data);
      setRequests((prev) => {
        if (prev.some((r) => r.id === record.id)) return prev;
        const next = [record, ...prev];
        return next.slice(0, maxItems);
      });
    });

    es.addEventListener('status', (event) => {
      setStatusEvent(JSON.parse(event.data));
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [maxItems]);

  return { requests, statusEvent, clearLocal };
}

// ── WebSocket messages ──

export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

export interface UiWsMessage {
  id: string;
  request_id: string;
  timestamp: number;
  /** 'sent' = client→server, 'received' = server→client */
  direction: 'sent' | 'received';
  opcode: WsOpcode;
  payload: string | null; // base64, or null when no payload was captured
  size: number;
  truncated: number;
}

export interface MessagesResponse {
  data: UiWsMessage[];
  total: number;
  limit: number;
  offset: number;
}

export async function getMessages(requestId: string): Promise<MessagesResponse> {
  const res = await fetch(`${API_BASE}/requests/${requestId}/messages`);
  if (!res.ok) throw new Error('Failed to load messages');
  return res.json();
}

export type WsReplayStopReason = 'idle' | 'close' | 'timeout' | 'error';

export interface WsReplayResponse {
  /** Frames handed to the socket before the replay ended. */
  sentCount: number;
  /** Frames the replay was asked to send, so `sentCount` has a denominator. */
  frameCount: number;
  /** False when the replay stopped before every requested frame went out. */
  sentAll: boolean;
  /** Server frames, in arrival order. `payload` is base64 for both opcodes. */
  received: { opcode: 'text' | 'binary'; payload: string; offsetMs: number }[];
  durationMs: number;
  /** The close code, when the connection closed before the replay ended. */
  closeCode: number | null;
  stoppedBecause: WsReplayStopReason;
  /** Present only when the replay failed or timed out. */
  error?: string;
}

/**
 * Replays a captured WebSocket connection by `requestId` only. Never post
 * `{ url, frames }` from the browser: `express.json()` on the server has no
 * `limit` override, so the default 100kb body cap applies, and a single
 * recorded frame's base64 payload can exceed that on its own — replaying
 * exactly the captures most worth replaying would fail.
 */
export async function replayWebSocketConnection(requestId: string): Promise<WsReplayResponse> {
  const res = await fetch(`${API_BASE}/websocket/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Replay failed');
  return res.json();
}

const WS_CONTROL_ESCAPES: Record<number, string> = {
  0x00: '\\0', 0x07: '\\a', 0x08: '\\b', 0x09: '\\t',
  0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x1b: '\\e',
};

/**
 * Neutralizes C0 control characters (including DEL, 0x7f) before a decoded
 * payload reaches the DOM — mirrors the CLI's `escapeWsControlChars` so a
 * captured frame (untrusted data) can't smuggle in stray control bytes that
 * would render oddly outside a normal text flow.
 */
export function escapeWsControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += WS_CONTROL_ESCAPES[code] ?? `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
  return new TextDecoder('utf-8').decode(bytes);
}

const WS_PAYLOAD_DISPLAY_LIMIT = 4000;

/**
 * Renders a WS frame's payload for display.
 *
 * - `payload === null` (no payload captured) is reported as `'(no payload)'`
 *   — distinct from an empty string, which is a real zero-length frame.
 * - Non-`text` opcodes (binary/ping/pong/close) are never decoded, matching
 *   the CLI: `<N bytes>`.
 * - `text` frames are UTF-8 decoded; if the decoded text parses as JSON it is
 *   pretty-printed (JSON.stringify already escapes any control characters
 *   inside string values, so `escapeWsControlChars` is NOT re-applied to the
 *   pretty-printed structural newlines — doing so would turn real indentation
 *   back into literal "\n" text). Non-JSON text has its control characters
 *   escaped directly.
 * - Display is capped at `maxChars` — but capping is always announced with a
 *   trailing "[+N more characters hidden]" note, never a silent cut.
 */
export function formatWsPayload(
  message: { opcode: WsOpcode; payload: string | null; size: number },
  maxChars = WS_PAYLOAD_DISPLAY_LIMIT,
): string {
  if (message.payload === null) return '(no payload)';
  if (message.opcode !== 'text') return `<${message.size} bytes>`;

  let text: string;
  try {
    text = base64ToUtf8(message.payload);
  } catch {
    return `<${message.size} bytes> (undecodable)`;
  }

  let display: string;
  try {
    display = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    display = escapeWsControlChars(text);
  }

  if (display.length <= maxChars) return display;
  const hidden = display.length - maxChars;
  return `${display.slice(0, maxChars)}\n… [+${hidden} more character${hidden === 1 ? '' : 's'} hidden]`;
}

export interface WsReplayOutcome {
  level: 'success' | 'warning' | 'error';
  summary: string;
}

/**
 * Maps a replay response's `stoppedBecause` to a user-facing verdict.
 *
 * Must never collapse 'idle' or 'timeout' into success: 'idle' means the
 * replay gave up after a 500ms quiet period, which happens routinely when a
 * server's first reply is just slower than that (e.g. behind a DB read) —
 * reporting that as "replay succeeded, zero replies" would misreport the
 * exact thing the user is trying to observe. 'close' is the only reason
 * treated as success. closeCode is surfaced whenever present, since on an
 * abrupt disconnect (1006, no error event) it's the only signal that
 * distinguishes "closed" from "cut".
 *
 * An incomplete send outranks `stoppedBecause` entirely. A server that closes
 * after the first of three frames stops the replay with `'close'`, and reading
 * only that reason renders a 1-of-3 replay as a green success — partial work
 * reported as complete, in the surface a person actually looks at. `sentAll` is
 * checked first, and the count is put in the text so the reader can see how far
 * it got rather than only that something was wrong.
 */
export function describeReplayOutcome(response: WsReplayResponse): WsReplayOutcome {
  const closeSuffix = response.closeCode !== null ? ` (close code ${response.closeCode})` : '';
  const replyCount = response.received.length;
  const replyNote = `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} received`;

  if (!response.sentAll) {
    return {
      level: 'error',
      summary: `Replay incomplete: only ${response.sentCount} of ${response.frameCount} frames were sent before the replay stopped (${response.stoppedBecause})${closeSuffix}.${response.error ? ` ${response.error}` : ''} ${replyNote}.`,
    };
  }

  switch (response.stoppedBecause) {
    case 'close':
      return {
        level: 'success',
        summary: `Replay finished: connection closed${closeSuffix}. ${replyNote}.`,
      };
    case 'idle':
      return {
        level: 'warning',
        summary: `Replay stopped after the server went quiet for 500ms${closeSuffix} — replies may be incomplete. ${replyNote} so far.`,
      };
    case 'timeout':
      return {
        level: 'error',
        summary: `Replay timed out before finishing${closeSuffix}.${response.error ? ` ${response.error}` : ''}`,
      };
    case 'error':
    default:
      return {
        level: 'error',
        summary: `Replay failed${closeSuffix}: ${response.error ?? 'unknown error'}`,
      };
  }
}

/**
 * Merges a freshly-fetched page of messages with whatever is already held
 * locally (e.g. a frame appended live via the `ws-message` SSE event while
 * the fetch was still in flight). The fetch result is not trusted as
 * necessarily complete: if the SSE stream delivered a frame between the
 * fetch firing and it resolving, and the fetch's own DB read predates that
 * frame, blindly replacing local state with the fetch result would silently
 * drop it — the connection would then appear to have carried less traffic
 * than it actually did. Dedupes by id (the fetched copy wins on conflict)
 * and sorts by timestamp so the race can't reorder frames either.
 */
export function mergeWsMessages(existing: UiWsMessage[], fetched: UiWsMessage[]): UiWsMessage[] {
  const byId = new Map<string, UiWsMessage>();
  for (const m of fetched) byId.set(m.id, m);
  for (const m of existing) if (!byId.has(m.id)) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export type WsMessagesState = 'loading' | 'loaded' | 'error';

export interface UseWsMessagesResult {
  messages: UiWsMessage[];
  total: number;
  state: WsMessagesState;
  error: string | null;
}

/**
 * Loads a WebSocket connection's captured frames and keeps them live via the
 * `ws-message` SSE event, filtered to this connection. Intended to be
 * mounted only while the Messages tab is active — mount/unmount is the
 * activation signal, so there's no separate "active" flag to keep in sync.
 *
 * Distinguishes loading/loaded/error explicitly: a failed fetch surfaces as
 * `state: 'error'`, never as an empty `messages` array. Collapsing "fetch
 * failed" into "no messages" would misreport a connection that errored as
 * one that carried no traffic at all — the same failure class as Task 6's
 * throttle control reporting unknown state as "off".
 */
export function useWsMessages(requestId: string): UseWsMessagesResult {
  const [data, setData] = useState<{ messages: UiWsMessage[]; total: number }>({ messages: [], total: 0 });
  const [state, setState] = useState<WsMessagesState>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError(null);
    getMessages(requestId).then((result) => {
      if (cancelled) return;
      setData((prev) => {
        const messages = mergeWsMessages(prev.messages, result.data);
        return { messages, total: Math.max(result.total, messages.length) };
      });
      setState('loaded');
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      setState('error');
    });
    return () => { cancelled = true; };
  }, [requestId]);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events`);
    es.addEventListener('ws-message', (event) => {
      const message = JSON.parse((event as MessageEvent).data) as UiWsMessage;
      if (message.request_id !== requestId) return;
      setData((prev) => {
        if (prev.messages.some((m) => m.id === message.id)) return prev;
        return { messages: [...prev.messages, message], total: prev.total + 1 };
      });
    });
    return () => es.close();
  }, [requestId]);

  return { messages: data.messages, total: data.total, state, error };
}
