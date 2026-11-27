import { useEffect, useRef } from 'react';

export type ConsoleRow = {
  n: number;
  from: string;
  to: string;
  subject: string;
  status: string;
  detail?: string;
};

function statusClass(status: string) {
  if (status === 'FAILED' || status === 'BOUNCED') return 'st-fail';
  if (status === 'QUEUED') return 'st-wait';
  return 'st-sent';
}

function statusLabel(status: string) {
  if (status === 'DELIVERED') return 'SENT';
  return status;
}

/** Live send console: one row per address, the same columns as a mailer email log. */
export function SendConsole({ rows, stickToEnd }: { rows: ConsoleRow[]; stickToEnd: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = stickToEnd ? el.scrollHeight : 0;
  }, [rows, stickToEnd]);

  return (
    <div className="email-log" ref={scroller}>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Type</th>
            <th>From</th>
            <th>To</th>
            <th>Subject</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr key={`${row.n}-${row.to}-${row.status}`}>
                <td>{row.n}</td>
                <td>
                  <span className="type-pill">SMTP</span>
                </td>
                <td>{row.from || '—'}</td>
                <td>{row.to}</td>
                <td>{row.subject || '—'}</td>
                <td className={statusClass(row.status)} title={row.detail || undefined}>
                  {statusLabel(row.status)}
                  {row.detail && statusLabel(row.status) !== 'SENT' ? <div className="meta">{row.detail}</div> : null}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={6}>No sends yet. Each address shows here as it goes out.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
