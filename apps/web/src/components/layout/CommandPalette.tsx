import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

type CommandItem = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  extra = [],
}: {
  open: boolean;
  onClose: () => void;
  extra?: CommandItem[];
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);

  const items = useMemo(() => {
    const base: CommandItem[] = [
      { id: 'dash', label: 'Go to Dashboard', hint: '1', run: () => navigate('/app') },
      { id: 'camp', label: 'Go to Campaigns', hint: '2', run: () => navigate('/app/campaigns') },
      { id: 'templates', label: 'Go to Templates', hint: '3', run: () => navigate('/app/templates') },
      { id: 'ai', label: 'Go to AI Assistant', hint: '4', run: () => navigate('/app/ai') },
      { id: 'contacts', label: 'Go to Contacts', hint: '5', run: () => navigate('/app/contacts') },
      { id: 'domains', label: 'Go to Domains', hint: '6', run: () => navigate('/app/domains') },
      { id: 'analytics', label: 'Go to Analytics', hint: '7', run: () => navigate('/app/analytics') },
      { id: 'smtp', label: 'Open SMTP Manager', hint: 'S', run: () => navigate('/app/smtp') },
      { id: 'settings', label: 'Open Settings', hint: '8', run: () => navigate('/app/settings') },
      { id: 'admin', label: 'Open Admin', hint: '9', run: () => navigate('/app/admin') },
      { id: 'new-camp', label: 'New campaign', run: () => navigate('/app/campaigns/new') },
      ...extra,
    ];
    const query = q.trim().toLowerCase();
    if (!query) return base;
    return base.filter((i) => i.label.toLowerCase().includes(query));
  }, [navigate, q, extra]);

  useEffect(() => {
    if (!open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[active];
        if (item) {
          item.run();
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items, active, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 px-3 pt-[max(2rem,8vh)] font-mono sm:px-4 sm:pt-[12vh]">
      <button type="button" className="absolute inset-0" aria-label="Close" onClick={onClose} />
      <div className="relative z-10 w-full max-w-xl overflow-hidden border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 text-primary" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder="Type a command…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="border border-border px-1.5 text-[10px] text-accent">esc</kbd>
        </div>
        <ul className="max-h-80 overflow-auto py-1">
          {items.map((item, idx) => (
            <li key={item.id}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center justify-between px-3 py-2 text-left text-sm',
                  idx === active ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-muted',
                )}
                onMouseEnter={() => setActive(idx)}
                onClick={() => {
                  item.run();
                  onClose();
                }}
              >
                <span>{item.label}</span>
                {item.hint ? <span className="text-[10px] text-muted-foreground">{item.hint}</span> : null}
              </button>
            </li>
          ))}
          {!items.length ? (
            <li className="px-3 py-4 text-sm text-muted-foreground">No matching commands</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
