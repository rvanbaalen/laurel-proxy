import { useState, useEffect, useCallback } from 'react';
import { fetchRequest, replayWebSocketConnection, formatWsPayload, describeReplayOutcome, useWsMessages, wireProtocolLabel } from '../client.ts';
import type { RequestRecord, UiWsMessage, WsReplayResponse } from '../client.ts';

const SKIP_HEADERS = new Set([
  'proxy-connection', 'proxy-authorization', 'connection',
  'keep-alive', 'transfer-encoding', 'upgrade',
]);

function buildCurlCommand(record: RequestRecord): string {
  const parts = ['curl'];
  if (record.method !== 'GET') parts.push(`-X ${record.method}`);
  const headers = parseHeaders(record.request_headers);
  for (const [key, value] of Object.entries(headers)) {
    if (SKIP_HEADERS.has(key.toLowerCase())) continue;
    parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
  }
  if (record.request_body) {
    const body = decodeBody(record.request_body);
    if (body) parts.push(`-d ${shellQuote(body)}`);
  }
  parts.push(shellQuote(record.url));
  return parts.join(' \\\n  ');
}

function shellQuote(s: string): string {
  if (!/[^a-zA-Z0-9@%_+=:,./-]/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const statusColor = (status: number | null) => {
  if (!status) return 'text-text-muted';
  if (status < 300) return 'text-accent';
  if (status < 400) return 'text-blue-400';
  if (status < 500) return 'text-orange-400';
  return 'text-red-400';
};

const methodColor = (method: string) => {
  const colors: Record<string, string> = {
    GET: 'text-blue-400',
    POST: 'text-accent',
    PUT: 'text-yellow-400',
    PATCH: 'text-orange-400',
    DELETE: 'text-red-400',
  };
  return colors[method] || 'text-text-muted';
};

interface RequestDetailProps {
  requestId: string;
  onClose: () => void;
  onSendToRepeater?: (data: { url: string; method: string; headers: string; body: string; originalResponse?: { status: number | null; body: string | null; contentType: string | null } }) => void;
}

export function RequestDetail({ requestId, onClose, onSendToRepeater }: RequestDetailProps) {
  const [record, setRecord] = useState<RequestRecord | null>(null);
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'messages'>('response');
  const [copied, setCopied] = useState(false);

  useEffect(() => { fetchRequest(requestId).then(setRecord); }, [requestId]);

  // Reset the tab whenever the selection changes, so switching from a
  // WebSocket connection (Messages tab active) to an ordinary HTTP request
  // can't leave `activeTab` pointing at a tab that no longer exists.
  useEffect(() => { setActiveTab('response'); }, [requestId]);

  // Safety net for the same failure mode: if `record` ever settles into a
  // state where the current tab isn't available (kind isn't 'websocket'),
  // fall back rather than rendering a blank panel.
  useEffect(() => {
    if (activeTab === 'messages' && record?.kind !== 'websocket') {
      setActiveTab('response');
    }
  }, [activeTab, record]);

  const copyCurl = useCallback(() => {
    if (!record) return;
    navigator.clipboard.writeText(buildCurlCommand(record)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [record]);

  const sendToRepeater = useCallback(() => {
    if (!record || !onSendToRepeater) return;
    const headers = parseHeaders(record.request_headers);
    const headersText = Object.entries(headers)
      .filter(([key]) => !SKIP_HEADERS.has(key.toLowerCase()))
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    const body = record.request_body ? decodeBody(record.request_body) : '';
    onSendToRepeater({
      url: record.url,
      method: record.method,
      headers: headersText,
      body,
      originalResponse: {
        status: record.status,
        body: record.response_body,
        contentType: record.content_type,
      },
    });
  }, [record, onSendToRepeater]);

  if (!record) return <div className="p-4 text-text-muted text-sm">Loading...</div>;

  const requestHeaders = parseHeaders(record.request_headers);
  const responseHeaders = parseHeaders(record.response_headers);

  return (
    <div className="flex flex-col h-full bg-bg-primary md:border-l border-border-subtle">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle">
        <div className="flex items-center gap-2 text-xs font-mono min-w-0">
          <span className={`font-semibold ${methodColor(record.method)}`}>{record.method}</span>
          <span className={`${statusColor(record.status)}`}>{record.status}</span>
          <span className="text-text-secondary truncate">{record.url}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onSendToRepeater && (
            <button onClick={sendToRepeater} className="px-2 py-0.5 text-[11px] rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
              Repeater
            </button>
          )}
          <button onClick={copyCurl} className="px-2 py-0.5 text-[11px] rounded-md border border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
            {copied ? 'Copied!' : 'cURL'}
          </button>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary text-lg px-1.5 transition-colors">&times;</button>
        </div>
      </div>

      {/* Meta */}
      <div className="flex gap-4 px-4 py-1.5 text-[11px] text-text-muted border-b border-border-subtle font-mono">
        <span>{record.duration}ms</span>
        <span>{record.response_size}B</span>
        <span>{record.protocol}</span>
        <span title="client hop → origin hop">
          {wireProtocolLabel(record.client_protocol)} → {wireProtocolLabel(record.origin_protocol)}
        </span>
        <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border-subtle">
        <button
          onClick={() => setActiveTab('request')}
          className={`px-4 py-2 text-xs transition-all duration-200 ease-bounce ${
            activeTab === 'request'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-muted hover:text-text-secondary border-b-2 border-transparent'
          }`}
        >Request</button>
        <button
          onClick={() => setActiveTab('response')}
          className={`px-4 py-2 text-xs transition-all duration-200 ease-bounce ${
            activeTab === 'response'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-muted hover:text-text-secondary border-b-2 border-transparent'
          }`}
        >Response</button>
        {record.kind === 'websocket' && (
          <button
            onClick={() => setActiveTab('messages')}
            className={`px-4 py-2 text-xs transition-all duration-200 ease-bounce ${
              activeTab === 'messages'
                ? 'text-text-primary border-b-2 border-accent'
                : 'text-text-muted hover:text-text-secondary border-b-2 border-transparent'
            }`}
          >Messages</button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'request' ? (
          <><HeadersView headers={requestHeaders} /><BodyView body={record.request_body} contentType={null} /></>
        ) : activeTab === 'response' ? (
          <><HeadersView headers={responseHeaders} /><BodyView body={record.response_body} contentType={record.content_type} /></>
        ) : (
          <MessagesView requestId={record.id} />
        )}
      </div>
    </div>
  );
}

function MessagesView({ requestId }: { requestId: string }) {
  const { messages, total, state, error } = useWsMessages(requestId);

  if (state === 'loading') {
    return <div className="text-text-muted text-xs">Loading messages…</div>;
  }

  if (state === 'error') {
    return (
      <div className="text-red-400 text-xs">
        Failed to load messages: {error}
      </div>
    );
  }

  return (
    <div>
      {messages.length === 0 ? (
        <div className="text-text-muted text-xs mb-4">No messages captured for this connection.</div>
      ) : (
        <>
          {total > messages.length && (
            <div className="text-[10px] text-text-muted mb-2">
              Showing {messages.length} of {total} captured frames.
            </div>
          )}
          <div className="space-y-1.5 mb-4">
            {messages.map((m) => <MessageRow key={m.id} message={m} />)}
          </div>
        </>
      )}
      <ReplayControl requestId={requestId} />
    </div>
  );
}

function MessageRow({ message }: { message: UiWsMessage }) {
  const arrow = message.direction === 'sent' ? '→' : '←';
  const arrowColor = message.direction === 'sent' ? 'text-accent' : 'text-text-secondary';
  const time = new Date(message.timestamp).toISOString().slice(11, 23);

  return (
    <div className="font-mono text-[11px] border border-border-subtle rounded-md p-2 bg-bg-secondary">
      <div className="flex items-center gap-2 text-text-muted">
        <span className={`font-semibold ${arrowColor}`}>{arrow}</span>
        <span>{message.opcode}</span>
        <span>{message.size}B</span>
        <span>{time}</span>
        {message.truncated !== 0 && (
          <span className="text-yellow-400">truncated at capture</span>
        )}
      </div>
      <pre className="whitespace-pre-wrap text-text-secondary mt-1">{formatWsPayload(message)}</pre>
    </div>
  );
}

function replySize(payload: string): number {
  try { return atob(payload).length; } catch { return 0; }
}

function ReplayControl({ requestId }: { requestId: string }) {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<WsReplayResponse | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const runReplay = useCallback(() => {
    setLoading(true);
    setResponse(null);
    setReplayError(null);
    replayWebSocketConnection(requestId)
      .then(setResponse)
      .catch((err) => setReplayError(err instanceof Error ? err.message : 'Replay failed'))
      .finally(() => setLoading(false));
  }, [requestId]);

  const outcome = response ? describeReplayOutcome(response) : null;
  const outcomeColor = outcome?.level === 'success'
    ? 'text-accent'
    : outcome?.level === 'warning'
      ? 'text-yellow-400'
      : 'text-red-400';

  return (
    <div className="pt-3 border-t border-border-subtle">
      <button
        onClick={runReplay}
        disabled={loading}
        className="px-3 py-1 text-[11px] rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
      >
        {loading ? 'Replaying…' : 'Replay connection'}
      </button>

      {replayError && (
        <p className="mt-2 text-[11px] text-red-400">{replayError}</p>
      )}

      {outcome && (
        <div className="mt-2">
          <p className={`text-[11px] ${outcomeColor}`}>{outcome.summary}</p>
          {response && response.received.length > 0 && (
            <div className="space-y-1.5 mt-2">
              {response.received.map((r, i) => (
                <pre
                  key={i}
                  className="font-mono text-[10px] text-text-secondary bg-bg-secondary border border-border-subtle rounded-md p-2 whitespace-pre-wrap"
                >
                  {formatWsPayload({ opcode: r.opcode, payload: r.payload, size: replySize(r.payload) })}
                </pre>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HeadersView({ headers }: { headers: Record<string, string> }) {
  return (
    <div className="mb-5">
      <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.05em] mb-2">Headers</h3>
      <div className="font-mono text-[11px] leading-[1.8]">
        {Object.entries(headers).map(([key, value]) => (
          <div key={key}>
            <span className="text-accent">{key}</span>
            <span className="text-text-muted">: </span>
            <span className="text-text-secondary">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function decodeBody(body: string): string {
  try { return atob(body); } catch { return body; }
}

function BodyView({ body, contentType }: { body: string | null; contentType: string | null }) {
  if (!body) return null;
  let formatted = decodeBody(body);
  if (contentType?.includes('json') || formatted.startsWith('{') || formatted.startsWith('[')) {
    try { formatted = JSON.stringify(JSON.parse(formatted), null, 2); } catch {}
  }
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.05em] mb-2">Body</h3>
      <pre className="font-mono text-[11px] text-text-secondary bg-bg-secondary rounded-md p-3 overflow-auto whitespace-pre-wrap border border-border-subtle">{formatted}</pre>
    </div>
  );
}

function parseHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
