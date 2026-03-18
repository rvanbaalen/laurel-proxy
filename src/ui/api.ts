import { useState, useEffect } from 'react';

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
