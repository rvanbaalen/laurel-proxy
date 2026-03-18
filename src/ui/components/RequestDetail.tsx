import { useState, useEffect, useCallback } from 'react';
import { fetchRequest } from '../api.ts';
import type { RequestRecord } from '../api.ts';

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

interface RequestDetailProps {
  requestId: string;
  onClose: () => void;
}

export function RequestDetail({ requestId, onClose }: RequestDetailProps) {
  const [record, setRecord] = useState<RequestRecord | null>(null);
  const [activeTab, setActiveTab] = useState<'request' | 'response'>('response');

  useEffect(() => { fetchRequest(requestId).then(setRecord); }, [requestId]);

  const [copied, setCopied] = useState(false);

  const copyCurl = useCallback(() => {
    if (!record) return;
    navigator.clipboard.writeText(buildCurlCommand(record)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [record]);

  if (!record) return <div className="p-4 text-gray-500">Loading...</div>;

  const requestHeaders = parseHeaders(record.request_headers);
  const responseHeaders = parseHeaders(record.response_headers);

  return (
    <div className="flex flex-col h-full bg-gray-900 border-l border-gray-800">
      <div className="flex items-center justify-between p-3 border-b border-gray-800">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="font-mono font-bold text-blue-400">{record.method}</span>
          <span className="font-mono text-green-400">{record.status}</span>
          <span className="text-gray-400 truncate">{record.url}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={copyCurl} className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors" title="Copy as cURL">
            {copied ? 'Copied!' : 'cURL'}
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg px-2">&times;</button>
        </div>
      </div>
      <div className="flex gap-4 px-3 py-2 text-xs text-gray-500 border-b border-gray-800">
        <span>Duration: {record.duration}ms</span>
        <span>Size: {record.response_size}B</span>
        <span>Protocol: {record.protocol}</span>
        <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="flex border-b border-gray-800">
        <button onClick={() => setActiveTab('request')} className={`px-4 py-2 text-sm ${activeTab === 'request' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500'}`}>Request</button>
        <button onClick={() => setActiveTab('response')} className={`px-4 py-2 text-sm ${activeTab === 'response' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500'}`}>Response</button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {activeTab === 'request' ? (
          <><HeadersView headers={requestHeaders} /><BodyView body={record.request_body} contentType={null} /></>
        ) : (
          <><HeadersView headers={responseHeaders} /><BodyView body={record.response_body} contentType={record.content_type} /></>
        )}
      </div>
    </div>
  );
}

function HeadersView({ headers }: { headers: Record<string, string> }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Headers</h3>
      <div className="font-mono text-xs space-y-0.5">
        {Object.entries(headers).map(([key, value]) => (
          <div key={key}><span className="text-purple-400">{key}</span><span className="text-gray-600">: </span><span className="text-gray-300">{value}</span></div>
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
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Body</h3>
      <pre className="font-mono text-xs text-gray-300 bg-gray-950 rounded p-3 overflow-auto whitespace-pre-wrap">{formatted}</pre>
    </div>
  );
}

function parseHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
