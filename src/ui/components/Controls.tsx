import { useState, useEffect, useRef, useLayoutEffect, type RefObject } from 'react';
import { fetchStatus, startProxy, stopProxy, clearRequests, fetchSystemProxyStatus, enableSystemProxy, disableSystemProxy } from '../client.ts';
import type { ProxyStatus } from '../client.ts';

interface ControlsProps {
  onClear: () => void;
  statusEvent?: { running: boolean; proxyPort: number } | null;
  activeView: 'traffic' | 'repeater';
  onViewChange: (view: 'traffic' | 'repeater') => void;
  repeaterCount: number;
  filterSearch: string;
  onSearchChange: (v: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function Controls({ onClear, statusEvent, activeView, onViewChange, repeaterCount, filterSearch, onSearchChange, searchRef }: ControlsProps) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);

  const loadStatus = async () => {
    try { const s = await fetchStatus(); setStatus(s); } catch { setStatus(null); }
  };

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (statusEvent && status) {
      setStatus((prev) => prev ? { ...prev, running: statusEvent.running, proxyPort: statusEvent.proxyPort } : prev);
    }
  }, [statusEvent]);

  const toggleProxy = async () => {
    if (status?.running) { await stopProxy(); } else { await startProxy(); }
    await loadStatus();
  };

  const [systemProxy, setSystemProxy] = useState(false);

  useEffect(() => {
    fetchSystemProxyStatus().then(setSystemProxy).catch(() => {});
  }, []);

  // Re-check system proxy status when proxy starts/stops
  useEffect(() => {
    fetchSystemProxyStatus().then(setSystemProxy).catch(() => {});
  }, [statusEvent?.running]);

  const toggleSystemProxy = async () => {
    if (systemProxy) {
      const r = await disableSystemProxy();
      if (r.ok) setSystemProxy(false);
    } else {
      const r = await enableSystemProxy();
      if (r.ok) setSystemProxy(true);
    }
  };

  const handleClear = async () => { await clearRequests(); onClear(); await loadStatus(); };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border-subtle bg-bg-primary h-12">
      {/* Logo */}
      <h1 className="font-mono text-sm font-bold text-text-primary tracking-tight whitespace-nowrap">
        Laurel<span className="text-accent">Proxy</span>
      </h1>

      {/* Status pill */}
      <button
        onClick={toggleProxy}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
          status?.running
            ? 'bg-accent/10 text-accent border-accent/20 hover:bg-accent/20'
            : 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${status?.running ? 'bg-accent animate-pulse-dot' : 'bg-red-400'}`} />
        {status?.running ? `Running :${status.proxyPort}` : 'Stopped'}
      </button>

      {/* System proxy toggle */}
      <button
        onClick={toggleSystemProxy}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all duration-200 ease-bounce whitespace-nowrap ${
          systemProxy
            ? 'bg-accent/10 text-accent border-accent/20 hover:bg-accent/20 scale-100'
            : 'bg-bg-secondary text-text-muted border-border hover:border-text-muted hover:text-text-secondary scale-100'
        }`}
        title={systemProxy ? 'System proxy enabled — click to disable' : 'System proxy disabled — click to enable'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
        System Proxy
      </button>

      {/* Filter input */}
      <div className="flex-1 max-w-lg flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border border-border-subtle rounded-md text-xs text-text-muted cursor-text min-w-0 mx-auto transition-[border-color,box-shadow] duration-150 focus-within:border-accent/30 focus-within:shadow-[0_0_8px_rgba(34,197,94,0.08)]"
        onClick={() => searchRef.current?.focus()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 opacity-50">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          ref={searchRef}
          type="text"
          placeholder="Filter requests..."
          value={filterSearch}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 bg-transparent outline-none text-text-secondary placeholder:text-text-muted min-w-0"
        />
        <kbd className="hidden sm:inline text-[10px] px-1.5 py-0.5 bg-bg-tertiary border border-border rounded text-text-muted font-sans">
          &#8984;K
        </kbd>
      </div>

      {/* View toggle */}
      <ViewToggle activeView={activeView} onViewChange={onViewChange} repeaterCount={repeaterCount} />

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <button onClick={handleClear} className="px-2.5 py-1 text-[11px] rounded-md border border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
          Clear
        </button>
        <a href="/api/ca.crt" download className="px-2.5 py-1 text-[11px] rounded-md border border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
          CA Cert
        </a>
      </div>
    </div>
  );
}

function ViewToggle({ activeView, onViewChange, repeaterCount }: { activeView: 'traffic' | 'repeater'; onViewChange: (v: 'traffic' | 'repeater') => void; repeaterCount: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trafficRef = useRef<HTMLButtonElement>(null);
  const repeaterRef = useRef<HTMLButtonElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const active = activeView === 'traffic' ? trafficRef.current : repeaterRef.current;
    if (!container || !active) return;
    const cRect = container.getBoundingClientRect();
    const aRect = active.getBoundingClientRect();
    setPill({ left: aRect.left - cRect.left, width: aRect.width });
  }, [activeView, repeaterCount]);

  return (
    <div ref={containerRef} className="relative flex p-0.5 bg-bg-secondary border border-border-subtle rounded-md">
      <div
        className="absolute top-0.5 bottom-0.5 bg-bg-tertiary rounded transition-all duration-250 ease-bounce"
        style={{ left: pill.left, width: pill.width }}
      />
      <button
        ref={trafficRef}
        onClick={() => onViewChange('traffic')}
        className={`relative z-10 px-2.5 py-1 text-[11px] rounded transition-colors duration-150 ${
          activeView === 'traffic' ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
        }`}
      >Traffic</button>
      <button
        ref={repeaterRef}
        onClick={() => onViewChange('repeater')}
        className={`relative z-10 px-2.5 py-1 text-[11px] rounded transition-colors duration-150 ${
          activeView === 'repeater' ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
        }`}
      >Repeater{repeaterCount > 0 && ` (${repeaterCount})`}</button>
    </div>
  );
}
