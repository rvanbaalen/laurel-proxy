import { useState, useMemo, useCallback } from 'react';
import { Controls } from './components/Controls.tsx';
import { FilterBar } from './components/FilterBar.tsx';
import { TrafficList } from './components/TrafficList.tsx';
import { RequestDetail } from './components/RequestDetail.tsx';
import { ResizeHandle } from './components/ResizeHandle.tsx';
import { Repeater, createTab } from './components/Repeater.tsx';
import type { RepeaterTabData } from './components/Repeater.tsx';
import { useSSE } from './api.ts';

const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 500;

export function App() {
  const { requests: liveRequests, statusEvent, clearLocal } = useSSE(500);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [activeView, setActiveView] = useState<'traffic' | 'repeater'>('traffic');

  // Repeater state
  const [repeaterTabs, setRepeaterTabs] = useState<RepeaterTabData[]>([]);
  const [activeRepeaterTab, setActiveRepeaterTab] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterSearch, setFilterSearch] = useState('');

  const filteredRequests = useMemo(() => {
    const status = filterStatus;
    const method = filterMethod;
    const search = filterSearch.toLowerCase();

    if (!status && !method && !search) return liveRequests;

    return liveRequests.filter((r) => {
      if (status && String(r.status) !== status) return false;
      if (method && r.method !== method) return false;
      if (search && !r.url.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [liveRequests, filterStatus, filterMethod, filterSearch]);

  const handleClear = useCallback(() => { setSelectedId(null); clearLocal(); }, [clearLocal]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(prev => prev === id ? null : id);
  }, []);

  const handleResize = useCallback((delta: number) => {
    setPanelWidth(prev => Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, prev + delta)));
  }, []);

  const clearFilters = useCallback(() => {
    setFilterStatus('');
    setFilterMethod('');
    setFilterSearch('');
  }, []);

  const handleSendToRepeater = useCallback((data: { url: string; method: string; headers: string; body: string }) => {
    const tab = createTab(data);
    setRepeaterTabs((prev) => [...prev, tab]);
    setActiveRepeaterTab(tab.id);
    setActiveView('repeater');
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <Controls onClear={handleClear} statusEvent={statusEvent} />
      {/* View tabs */}
      <div className="flex border-b border-gray-800 bg-gray-900">
        <button
          onClick={() => setActiveView('traffic')}
          className={`px-4 py-2 text-sm font-medium ${activeView === 'traffic' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'}`}
        >Traffic</button>
        <button
          onClick={() => setActiveView('repeater')}
          className={`px-4 py-2 text-sm font-medium ${activeView === 'repeater' ? 'text-white border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'}`}
        >
          Repeater{repeaterTabs.length > 0 && ` (${repeaterTabs.length})`}
        </button>
      </div>

      {activeView === 'traffic' && (
        <>
          <FilterBar
            status={filterStatus} method={filterMethod} search={filterSearch}
            onStatusChange={setFilterStatus}
            onMethodChange={setFilterMethod} onSearchChange={setFilterSearch}
            onClearFilters={clearFilters}
            matchCount={filteredRequests.length} totalCount={liveRequests.length}
          />
          <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-col flex-1 min-w-0">
              <TrafficList requests={filteredRequests} selectedId={selectedId} onSelect={handleSelect} />
            </div>
            {selectedId && (
              <>
                <ResizeHandle onResize={handleResize} />
                <div className="flex-shrink-0 overflow-hidden" style={{ width: panelWidth }}>
                  <RequestDetail requestId={selectedId} onClose={() => setSelectedId(null)} onSendToRepeater={handleSendToRepeater} />
                </div>
              </>
            )}
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
