interface FilterBarProps {
  statuses: Set<string>;
  methods: Set<string>;
  kinds: Set<string>;
  onToggleStatus: (s: string) => void;
  onToggleMethod: (m: string) => void;
  onToggleKind: (k: string) => void;
  onClearFilters: () => void;
  matchCount: number;
  totalCount: number;
  errorCount: number;
}

const STATUS_CHIPS = ['2xx', '4xx', '5xx'] as const;
const METHOD_CHIPS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const KIND_CHIPS = ['WS'] as const;

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-0.5 rounded-full text-[11px] border transition-all duration-200 ease-bounce ${
        active
          ? 'border-accent text-accent bg-accent/5 shadow-[0_0_6px_rgba(34,197,94,0.15)] scale-110'
          : 'border-border text-text-muted hover:border-text-muted hover:text-text-secondary scale-100'
      }`}
    >
      {label}
    </button>
  );
}

export function FilterBar({
  statuses, methods, kinds,
  onToggleStatus, onToggleMethod, onToggleKind, onClearFilters,
  matchCount, totalCount, errorCount,
}: FilterBarProps) {
  const hasFilters = statuses.size > 0 || methods.size > 0 || kinds.size > 0;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-subtle bg-bg-primary overflow-x-auto">
      <Chip
        label="All"
        active={!hasFilters}
        onClick={onClearFilters}
      />
      {STATUS_CHIPS.map(s => (
        <Chip key={s} label={s} active={statuses.has(s)} onClick={() => onToggleStatus(s)} />
      ))}

      <div className="w-px h-4 bg-border shrink-0" />

      {METHOD_CHIPS.map(m => (
        <Chip key={m} label={m} active={methods.has(m)} onClick={() => onToggleMethod(m)} />
      ))}

      <div className="w-px h-4 bg-border shrink-0" />

      {KIND_CHIPS.map(k => (
        <Chip key={k} label={k} active={kinds.has(k)} onClick={() => onToggleKind(k)} />
      ))}

      <div className="ml-auto flex items-center gap-3 text-[11px] font-mono text-text-muted shrink-0">
        <span><strong className="text-text-secondary">{matchCount === totalCount ? totalCount : `${matchCount}/${totalCount}`}</strong> requests</span>
        {errorCount > 0 && <span><strong className="text-red-400">{errorCount}</strong> errors</span>}
      </div>
    </div>
  );
}
