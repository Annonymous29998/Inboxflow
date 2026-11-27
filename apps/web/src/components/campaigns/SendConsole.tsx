import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export type ConsoleLine = {
  at: string;
  status: string;
  email: string;
  detail: string;
};

function lineTime(at: string) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '--';
  return when.toLocaleTimeString();
}

function lineClass(status: string) {
  if (status === 'FAILED' || status === 'BOUNCED') return 'mailer-err';
  if (status === 'QUEUED') return 'mailer-warn';
  return 'mailer-ok';
}

/** The send log: one green line per address, and the list stays where you scroll. */
export function SendConsole({ lines }: { lines: ConsoleLine[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  useEffect(() => {
    const el = scroller.current;
    if (!el || !follow.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="mailer-logs" ref={scroller} onScroll={onScroll}>
      {lines.length ? (
        lines.map((line, index) => (
          <div key={`${line.at}-${line.email}-${line.status}-${index}`} className={cn(lineClass(line.status))}>
            [{lineTime(line.at)}] {line.status} {line.email}
            {line.detail ? ` - ${line.detail}` : ''}
          </div>
        ))
      ) : (
        <p className="mailer-hint">No lines yet. Each send shows here as it goes out.</p>
      )}
    </div>
  );
}
