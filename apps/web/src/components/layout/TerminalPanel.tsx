import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Search, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';

type SystemLog = {
  id: string;
  level: string;
  category: string;
  message: string;
  createdAt: string;
};

const levelClass: Record<string, string> = {
  INFO: 'text-accent',
  SUCCESS: 'text-primary',
  WARNING: 'text-warning',
  ERROR: 'text-destructive',
};

const selectClass =
  'h-8 min-w-[9.5rem] shrink-0 appearance-none rounded-none border border-border bg-background bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat px-2 pr-7 text-xs leading-8 text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/40';

const selectChevron =
  "bg-[url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2339ff14%22 stroke-width=%222%22%3E%3Cpath d=%22m6 9 6 6 6-6%22/%3E%3C/svg%3E')]";

export function TerminalPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose?: () => void;
}) {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [level, setLevel] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function load() {
    const params = new URLSearchParams();
    if (level) params.set('level', level);
    if (category) params.set('category', category);
    if (search) params.set('search', search);
    params.set('limit', '250');
    const data = await api.get<{ logs: SystemLog[] }>(`/api/logs?${params.toString()}`);
    setLogs(data.logs);
  }

  useEffect(() => {
    if (!open) return;
    load().catch(console.error);
    const t = window.setInterval(() => {
      load().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [open, level, category, search]);

  useEffect(() => {
    if (!autoScroll || !open) return;
    // Scroll only inside the terminal list — never the page
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll, open]);

  const filtered = useMemo(() => logs, [logs]);

  function copyAll() {
    const text = filtered
      .map(
        (l) =>
          `${new Date(l.createdAt).toISOString()} [${l.level}] [${l.category}] ${l.message}`,
      )
      .join('\n');
    void navigator.clipboard.writeText(text);
  }

  function download() {
    const text = filtered
      .map(
        (l) =>
          `${new Date(l.createdAt).toISOString()} [${l.level}] [${l.category}] ${l.message}`,
      )
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inboxflow-logs-${Date.now()}.txt`;
    a.click();
  }

  async function clearLogs() {
    await api.delete('/api/logs');
    setLogs([]);
  }

  if (!open) return null;

  return (
    <div className="flex h-52 shrink-0 flex-col border-t border-border bg-[#050805] font-mono text-xs sm:h-60 md:h-72">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-2 py-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center justify-between gap-2 sm:justify-start">
          <span className="text-[10px] uppercase tracking-wider text-accent">Terminal</span>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center border border-border text-muted-foreground hover:text-primary sm:hidden"
              aria-label="Close terminal"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="relative min-w-0 flex-1 basis-full sm:basis-[12rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 border-border bg-background py-0 pl-8 text-xs leading-8"
            placeholder="Search logs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search logs"
          />
        </div>

        <label className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            Level
          </span>
          <select
            className={cn(selectClass, selectChevron)}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            aria-label="Filter by level"
          >
            <option value="">All levels</option>
            <option value="INFO">INFO</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="WARNING">WARNING</option>
            <option value="ERROR">ERROR</option>
          </select>
        </label>

        <label className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            Category
          </span>
          <select
            className={cn(selectClass, selectChevron, 'min-w-[10.5rem]')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            <option value="smtp">smtp</option>
            <option value="queue">queue</option>
            <option value="campaign">campaign</option>
            <option value="delivery">delivery</option>
            <option value="bounce">bounce</option>
            <option value="auth">auth</option>
            <option value="system">system</option>
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={copyAll}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={download} title="Download logs">
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2"
            onClick={() => void clearLogs()}
            title="Clear logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          {onClose ? (
            <Button
              size="sm"
              variant="ghost"
              className="hidden h-8 px-2 sm:inline-flex"
              onClick={onClose}
              title="Close terminal"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-3 py-2 break-words">
        {filtered.map((log) => (
          <div key={log.id} className="whitespace-pre-wrap leading-5">
            <span className="text-muted-foreground">
              {new Date(log.createdAt).toLocaleTimeString()}
            </span>{' '}
            <span className={cn('font-semibold', levelClass[log.level] || 'text-foreground')}>
              [{log.level}]
            </span>{' '}
            <span className="text-accent">[{log.category}]</span> {log.message}
          </div>
        ))}
        {!filtered.length ? (
          <div className="text-muted-foreground">
            <span className="text-primary">$</span> waiting for system events…
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
