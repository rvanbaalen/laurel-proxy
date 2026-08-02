import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Controls } from './components/Controls.tsx';
import { FilterBar } from './components/FilterBar.tsx';
import { TrafficList } from './components/TrafficList.tsx';
import { RequestDetail } from './components/RequestDetail.tsx';
import { ResizeHandle } from './components/ResizeHandle.tsx';
import { Repeater, createTab } from './components/Repeater.tsx';
import type { RepeaterTabData } from './components/Repeater.tsx';
import { useSSE, recordKind } from './client.ts';

const FAVICON_RUNNING = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0a0a0a"/><circle cx="16" cy="16" r="4" fill="#22c55e"><animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/></circle><circle cx="16" cy="16" r="7" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.2"><animate attributeName="r" values="7;10;7" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.2;0;0.2" dur="2s" repeatCount="indefinite"/></circle></svg>')}`;

const FAVICON_STOPPED = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0a0a0a"/><circle cx="16" cy="16" r="4" fill="#f87171"/></svg>')}`;

const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 480;

export function App() {
  const { requests: liveRequests, statusEvent, clearLocal } = useSSE(500);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [activeView, setActiveView] = useState<'traffic' | 'repeater'>('traffic');

  const [repeaterTabs, setRepeaterTabs] = useState<RepeaterTabData[]>([]);
  const [activeRepeaterTab, setActiveRepeaterTab] = useState<string | null>(null);

  const [filterStatuses, setFilterStatuses] = useState<Set<string>>(new Set());
  const [filterMethods, setFilterMethods] = useState<Set<string>>(new Set());
  const [filterKinds, setFilterKinds] = useState<Set<string>>(new Set());
  const [filterSearch, setFilterSearch] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const filteredRequests = useMemo(() => {
    const search = filterSearch.toLowerCase();

    if (filterStatuses.size === 0 && filterMethods.size === 0 && filterKinds.size === 0 && !search) return liveRequests;

    return liveRequests.filter((r) => {
      if (filterStatuses.size > 0) {
        const matchesAny = Array.from(filterStatuses).some(status => {
          if (status === '2xx') return r.status != null && r.status >= 200 && r.status < 300;
          if (status === '4xx') return r.status != null && r.status >= 400 && r.status < 500;
          if (status === '5xx') return r.status != null && r.status >= 500 && r.status < 600;
          return String(r.status) === status;
        });
        if (!matchesAny) return false;
      }
      if (filterMethods.size > 0 && !filterMethods.has(r.method)) return false;
      if (filterKinds.size > 0) {
        const matchesAny = Array.from(filterKinds).some(kind => {
          if (kind === 'WS') return recordKind(r) === 'websocket';
          return false;
        });
        if (!matchesAny) return false;
      }
      if (search && !r.url.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [liveRequests, filterStatuses, filterMethods, filterKinds, filterSearch]);

  const errorCount = useMemo(() => liveRequests.filter(r => r.status != null && r.status >= 400).length, [liveRequests]);

  const handleClear = useCallback(() => { setSelectedId(null); clearLocal(); }, [clearLocal]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(prev => prev === id ? null : id);
  }, []);

  const handleResize = useCallback((delta: number) => {
    setPanelWidth(prev => Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, prev + delta)));
  }, []);

  const toggleStatus = useCallback((s: string) => {
    setFilterStatuses(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }, []);

  const toggleMethod = useCallback((m: string) => {
    setFilterMethods(prev => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }, []);

  const toggleKind = useCallback((k: string) => {
    setFilterKinds(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setFilterStatuses(new Set());
    setFilterMethods(new Set());
    setFilterKinds(new Set());
    setFilterSearch('');
  }, []);

  const handleSendToRepeater = useCallback((data: { url: string; method: string; headers: string; body: string; originalResponse?: { status: number | null; body: string | null; contentType: string | null } }) => {
    const tab = createTab(data);
    setRepeaterTabs((prev) => [...prev, tab]);
    setActiveRepeaterTab(tab.id);
    setActiveView('repeater');
  }, []);

  // Dynamic favicon based on proxy status
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = statusEvent?.running ? FAVICON_RUNNING : FAVICON_STOPPED;
  }, [statusEvent?.running]);

  // Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex flex-col h-screen font-sans">
      <Controls
        onClear={handleClear}
        statusEvent={statusEvent}
        activeView={activeView}
        onViewChange={setActiveView}
        repeaterCount={repeaterTabs.length}
        filterSearch={filterSearch}
        onSearchChange={setFilterSearch}
        searchRef={searchRef}
      />

      {activeView === 'traffic' && (
        <>
          <FilterBar
            statuses={filterStatuses}
            methods={filterMethods}
            kinds={filterKinds}
            onToggleStatus={toggleStatus}
            onToggleMethod={toggleMethod}
            onToggleKind={toggleKind}
            onClearFilters={clearFilters}
            matchCount={filteredRequests.length}
            totalCount={liveRequests.length}
            errorCount={errorCount}
          />
          <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-col flex-1 min-w-0">
              <TrafficList requests={filteredRequests} selectedId={selectedId} onSelect={handleSelect} />
            </div>
            <ResizeHandle onResize={handleResize} visible={!!selectedId} onDragStart={() => setIsDragging(true)} onDragEnd={() => setIsDragging(false)} />
            <div
              className="detail-panel flex-shrink-0"
              data-open={!!selectedId}
              data-dragging={isDragging}
              style={{ width: selectedId ? panelWidth : 0 }}
            >
              {selectedId && (
                <RequestDetail requestId={selectedId} onClose={() => setSelectedId(null)} onSendToRepeater={handleSendToRepeater} />
              )}
            </div>
          </div>
        </>
      )}

      {activeView === 'repeater' && (
        <div className="flex-1 overflow-hidden">
          <Repeater
            tabs={repeaterTabs}
            activeTabId={activeRepeaterTab}
            onTabsChange={setRepeaterTabs}
            onActiveTabChange={setActiveRepeaterTab}
          />
        </div>
      )}
    </div>
  );
}
