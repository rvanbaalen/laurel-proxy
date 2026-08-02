import { useState, useEffect, useRef, useLayoutEffect, type RefObject } from 'react';
import { Sliders } from '@phosphor-icons/react';
import { fetchStatus, startProxy, stopProxy, clearRequests, fetchSystemProxyStatus, enableSystemProxy, disableSystemProxy, setThrottle, activePreset, useThrottle, parseThrottleInputs } from '../client.ts';
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

  const { throttle, refresh: refreshThrottle } = useThrottle();
  const preset = activePreset(throttle);
  const throttleEnabled = !!throttle?.settings.enabled;

  const onPresetChange = async (nextPreset: string) => {
    try {
      await setThrottle({ preset: nextPreset });
    } catch {
      // Leave the previously confirmed state visible rather than showing
      // a value the server never accepted.
    } finally {
      // Re-fetch rather than trust the local optimistic value, so the
      // dropdown always reflects what the server actually has (whether the
      // PUT succeeded, failed, or something else changed it concurrently).
      refreshThrottle();
    }
  };

  // Custom throttle rate popover — the preset <select> above can't express
  // arbitrary --down/--up/--latency values, only the six named presets.
  const [customOpen, setCustomOpen] = useState(false);
  const [downInput, setDownInput] = useState('');
  const [upInput, setUpInput] = useState('');
  const [latencyInput, setLatencyInput] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [customSubmitting, setCustomSubmitting] = useState(false);
  const customPopoverRef = useRef<HTMLDivElement>(null);
  const customToggleRef = useRef<HTMLButtonElement>(null);
  const firstCustomInputRef = useRef<HTMLInputElement>(null);

  const openCustomPopover = () => {
    // Prefill with the server-confirmed values (not whatever the last failed
    // attempt showed), so reopening the popover never shows a rate the
    // server never actually applied.
    setDownInput(throttle ? String(throttle.settings.downKbps) : '');
    setUpInput(throttle ? String(throttle.settings.upKbps) : '');
    setLatencyInput(throttle ? String(throttle.settings.latencyMs) : '');
    setCustomError(null);
    setCustomOpen(true);
  };

  useEffect(() => {
    if (!customOpen) return;
    firstCustomInputRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCustomOpen(false);
    };
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The toggle button must be excluded too. Otherwise mousedown closes the
      // popover, then the button's click handler sees customOpen === false and
      // immediately reopens it — so the button could never close what it opened.
      if (customToggleRef.current?.contains(target)) return;
      if (customPopoverRef.current && !customPopoverRef.current.contains(target)) {
        setCustomOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [customOpen]);

  const submitCustomThrottle = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseThrottleInputs(downInput, upInput, latencyInput);
    if ('error' in parsed) {
      // Reject locally without ever calling the server — and without closing
      // the popover, so the rejected value stays visible next to the error
      // rather than silently reverting.
      setCustomError(parsed.error);
      return;
    }
    setCustomSubmitting(true);
    setCustomError(null);
    try {
      await setThrottle({ enabled: true, ...parsed.values });
      setCustomOpen(false);
    } catch (err) {
      // The server rejected it (400 validation, or 500 persistence failure).
      // Keep the popover open with the values still in the inputs and the
      // server's own error message — never treat this as applied.
      setCustomError(err instanceof Error ? err.message : 'Failed to apply custom rate');
    } finally {
      setCustomSubmitting(false);
      // Same reasoning as onPresetChange: trust the server's own state, not
      // an optimistic guess, whether the PUT succeeded or failed.
      refreshThrottle();
    }
  };

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

      {/* Throttle control */}
      <div className="relative flex items-center gap-1">
        <select
          value={preset}
          onChange={(e) => onPresetChange(e.target.value)}
          title={
            preset === 'unknown'
              ? 'Throttle state unavailable'
              : throttleEnabled
                ? `Throttling enabled (${preset}) — recorded durations include simulated delay`
                : 'Throttling disabled — select a network profile to simulate a slower connection'
          }
          className={`px-2.5 py-1 rounded-full text-[11px] font-medium border outline-none cursor-pointer transition-colors ${
            throttleEnabled
              ? 'bg-accent/10 text-accent border-accent/20 hover:bg-accent/20'
              : 'bg-bg-secondary text-text-muted border-border hover:border-text-muted hover:text-text-secondary'
          }`}
        >
          {preset === 'unknown' && <option value="unknown" disabled>…</option>}
          <option value="off">No Throttle</option>
          {Object.keys(throttle?.presets ?? {}).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
          {preset === 'custom' && <option value="custom" disabled>custom</option>}
        </select>

        <button
          ref={customToggleRef}
          type="button"
          onClick={() => (customOpen ? setCustomOpen(false) : openCustomPopover())}
          aria-haspopup="dialog"
          aria-expanded={customOpen}
          title="Set custom throttle rates"
          className={`p-1 rounded-md border transition-colors ${
            customOpen
              ? 'bg-accent/10 text-accent border-accent/20'
              : 'bg-bg-secondary text-text-muted border-border hover:border-text-muted hover:text-text-secondary'
          }`}
        >
          <Sliders size={12} weight="bold" />
        </button>

        {customOpen && (
          <div
            ref={customPopoverRef}
            role="dialog"
            aria-label="Custom throttle rates"
            className="absolute z-20 top-full left-0 mt-1.5 w-52 p-3 rounded-md border border-border bg-bg-secondary shadow-lg"
          >
            <form onSubmit={submitCustomThrottle} className="flex flex-col gap-2">
              <label className="flex flex-col gap-0.5 text-[10px] text-text-muted">
                Down (kbps)
                <input
                  ref={firstCustomInputRef}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={downInput}
                  onChange={(e) => setDownInput(e.target.value)}
                  className="px-2 py-1 rounded border border-border-subtle bg-bg-primary text-xs text-text-primary outline-none focus:border-accent/40"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] text-text-muted">
                Up (kbps)
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={upInput}
                  onChange={(e) => setUpInput(e.target.value)}
                  className="px-2 py-1 rounded border border-border-subtle bg-bg-primary text-xs text-text-primary outline-none focus:border-accent/40"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] text-text-muted">
                Latency (ms)
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={latencyInput}
                  onChange={(e) => setLatencyInput(e.target.value)}
                  className="px-2 py-1 rounded border border-border-subtle bg-bg-primary text-xs text-text-primary outline-none focus:border-accent/40"
                />
              </label>

              {customError && <p className="text-[11px] text-red-400">{customError}</p>}

              <div className="flex items-center justify-end gap-1.5 mt-1">
                <button
                  type="button"
                  onClick={() => setCustomOpen(false)}
                  className="px-2 py-1 text-[11px] rounded-md border border-border text-text-secondary hover:bg-bg-tertiary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={customSubmitting}
                  className="px-2 py-1 text-[11px] rounded-md border border-accent/20 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {customSubmitting ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

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
