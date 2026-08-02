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
