import { useState, useEffect } from 'react';
import { fetchStatus, startProxy, stopProxy, clearRequests } from '../api.ts';
import type { ProxyStatus } from '../api.ts';

interface ControlsProps {
  onClear: () => void;
  statusEvent?: { running: boolean; proxyPort: number } | null;
}

export function Controls({ onClear, statusEvent }: ControlsProps) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);

  const loadStatus = async () => {
    try { const s = await fetchStatus(); setStatus(s); } catch { setStatus(null); }
  };

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 5000);
    return () => clearInterval(timer);
  }, []);

  // Instantly update running state when SSE status event arrives
  useEffect(() => {
    if (statusEvent && status) {
      setStatus((prev) => prev ? { ...prev, running: statusEvent.running, proxyPort: statusEvent.proxyPort } : prev);
    }
  }, [statusEvent]);

  const toggleProxy = async () => {
    if (status?.running) { await stopProxy(); } else { await startProxy(); }
    await loadStatus();
  };

  const handleClear = async () => { await clearRequests(); onClear(); };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <div className="flex items-center gap-4 p-3 bg-gray-900 border-b border-gray-800">
      <h1 className="text-lg font-bold text-white mr-4">RoxyProxy</h1>
      <button onClick={toggleProxy} className={`px-3 py-1 rounded text-sm font-medium ${status?.running ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-green-600 hover:bg-green-700 text-white'}`}>
        {status?.running ? 'Stop' : 'Start'}
      </button>
      <button onClick={handleClear} className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1 rounded text-sm">Clear</button>
      {status && (
        <div className="flex items-center gap-4 text-sm text-gray-400 ml-auto">
          <span className={`flex items-center gap-1 ${status.running ? 'text-green-400' : 'text-red-400'}`}>
            <span className={`w-2 h-2 rounded-full ${status.running ? 'bg-green-400' : 'bg-red-400'}`} />
            {status.running ? 'Running' : 'Stopped'}
          </span>
          <span>Port: {status.proxyPort}</span>
          <span>Requests: {status.requestCount}</span>
          <span>DB: {formatBytes(status.dbSizeBytes)}</span>
          <a href="/api/ca.crt" download className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">CA Cert</a>
          {status.hostname && (
            <span className="text-gray-500" title="Open this URL on your iOS device to access the web UI and download the CA cert">
              Network: <a href={`http://${status.hostname}:${window.location.port || 8081}`} className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">{status.hostname}:{window.location.port || 8081}</a>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
