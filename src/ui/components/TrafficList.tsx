import { useState, useMemo, useCallback, useRef } from 'react';
import { CaretUp, CaretDown, CaretUpDown } from '@phosphor-icons/react';
import { useThrottle, recordKind } from '../client.ts';
import type { RequestRecord } from '../client.ts';

interface TrafficListProps {
  requests: RequestRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

type SortKey = 'timestamp' | 'method' | 'status' | 'host' | 'path' | 'duration' | 'response_size';
type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey; label: string; minPx: number; align?: 'right'; hideClass?: string }[] = [
  { key: 'timestamp', label: 'Time', minPx: 100 },
  { key: 'method', label: 'Method', minPx: 64 },
  { key: 'status', label: 'Status', minPx: 52 },
  { key: 'path', label: 'Path', minPx: 120 },
  { key: 'host', label: 'Host', minPx: 80, hideClass: 'hidden md:table-cell' },
  { key: 'duration', label: 'ms', minPx: 60, align: 'right', hideClass: 'hidden lg:table-cell' },
  { key: 'response_size', label: 'Size', minPx: 60, align: 'right', hideClass: 'hidden lg:table-cell' },
];

const INITIAL_WIDTHS = [0.12, 0.07, 0.06, 0.37, 0.20, 0.09, 0.09];

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

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const formatTimestamp = (ts: number) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
};

function compare(a: RequestRecord, b: RequestRecord, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === 'string') return av.localeCompare(bv as string);
  return (av as number) - (bv as number);
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <CaretUpDown size={12} className="shrink-0 text-text-muted/40" />;
  const Icon = dir === 'asc' ? CaretUp : CaretDown;
  return <Icon size={12} weight="bold" className="shrink-0 text-accent" />;
}

const renderCell = (req: RequestRecord, key: SortKey) => {
  switch (key) {
    case 'timestamp':
      return <span className="font-mono text-text-muted text-[11px] tabular-nums">{formatTimestamp(req.timestamp)}</span>;
    case 'method':
      return (
        <span className={`font-mono text-[11px] font-semibold ${methodColor(req.method)}`}>
          {recordKind(req) === 'websocket' && (
            <span
              className="mr-1 px-1 py-px rounded-sm text-[9px] font-bold border bg-accent/10 text-accent border-accent/20"
              title="WebSocket connection"
            >
              WS
            </span>
          )}
          {req.method}
        </span>
      );
    case 'status':
      return <span className={`font-mono text-[11px] ${statusColor(req.status)}`}>{req.status ?? '-'}</span>;
    case 'host':
      return <span className="text-text-muted text-[11px]">{req.host}</span>;
    case 'path':
      return <span className="text-text-secondary text-xs">{req.path}</span>;
    case 'duration':
      return <span className="text-text-muted text-[11px]">{req.duration ? `${req.duration}` : '-'}</span>;
    case 'response_size':
      return <span className="text-text-muted text-[11px]">{formatBytes(req.response_size)}</span>;
  }
};

export function TrafficList({ requests, selectedId, onSelect }: TrafficListProps) {
  const { throttle } = useThrottle();
  const throttleEnabled = !!throttle?.settings.enabled;
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [colWidths, setColWidths] = useState(INITIAL_WIDTHS);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ col: number; startX: number; widths: number[] } | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'timestamp' ? 'desc' : 'asc');
    }
  };

  const sorted = useMemo(() => {
    const copy = [...requests];
    copy.sort((a, b) => {
      const c = compare(a, b, sortKey);
      return sortDir === 'asc' ? c : -c;
    });
    return copy;
  }, [requests, sortKey, sortDir]);

  const handleResizeStart = useCallback((e: React.MouseEvent, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const cw = containerRef.current?.clientWidth ?? 1;
    dragRef.current = { col: colIndex, startX: e.clientX, widths: [...colWidths] };

    const onMove = (me: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = (me.clientX - drag.startX) / cw;
      const next = [...drag.widths];
      const maxGrow = drag.widths[colIndex + 1] - COLUMNS[colIndex + 1].minPx / cw;
      const maxShrink = drag.widths[colIndex] - COLUMNS[colIndex].minPx / cw;
      const clamped = Math.max(-maxShrink, Math.min(maxGrow, delta));
      next[colIndex] = drag.widths[colIndex] + clamped;
      next[colIndex + 1] = drag.widths[colIndex + 1] - clamped;
      setColWidths(next);
    };

    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [colWidths]);

  return (
    <div ref={containerRef} className="flex-1 overflow-auto">
      <table className="w-full text-sm table-auto md:table-fixed">
        <colgroup className="hidden md:table-column-group">
          {colWidths.map((w, i) => (
            <col key={i} style={{ width: `${(w * 100).toFixed(2)}%`, minWidth: COLUMNS[i].minPx }} />
          ))}
        </colgroup>
        <thead className="bg-bg-primary sticky top-0 z-10">
          <tr className="text-left border-b border-border-subtle">
            {COLUMNS.map((col, i) => (
              <th
                key={col.key}
                className={`px-4 py-1.5 relative cursor-pointer select-none text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted hover:text-text-secondary transition-colors ${col.align === 'right' ? 'text-right' : ''} ${col.hideClass || ''}`}
                onClick={() => handleSort(col.key)}
                title={col.key === 'duration' && throttleEnabled ? 'Throttling is enabled — durations include simulated delay' : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.key === 'duration' && throttleEnabled && (
                    <span className="text-accent normal-case tracking-normal" aria-hidden="true">*</span>
                  )}
                  <SortIcon active={sortKey === col.key} dir={sortDir} />
                </span>
                {i < COLUMNS.length - 1 && (
                  <div
                    className="absolute -right-1 top-0 bottom-0 w-2 cursor-col-resize z-10 group hidden md:block"
                    onMouseDown={(e) => handleResizeStart(e, i)}
                  >
                    <div className="mx-auto w-px h-full group-hover:bg-accent/40" />
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((req) => (
            <tr
              key={req.id}
              onClick={() => onSelect(req.id)}
              className={`border-b border-border-subtle/50 cursor-pointer transition-all duration-100 ease-smooth ${
                selectedId === req.id
                  ? 'bg-bg-secondary border-l-2 border-l-accent'
                  : 'border-l-2 border-l-transparent hover:bg-bg-secondary/50'
              }`}
            >
              {COLUMNS.map((col) => (
                <td
                  key={col.key}
                  className={`px-4 py-[7px] truncate font-mono ${col.align === 'right' ? 'text-right' : ''} ${col.hideClass || ''}`}
                >
                  {renderCell(req, col.key)}
                </td>
              ))}
            </tr>
          ))}
          {requests.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="px-4 py-16 text-center">
                <div className="text-text-muted text-sm">See every HTTP request. Debug anything.</div>
                <div className="text-text-muted/60 text-xs mt-1">Capture, inspect, and replay HTTP/HTTPS traffic.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
