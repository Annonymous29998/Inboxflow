import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { toast } from '@/stores/toast';
import { cn } from '@/lib/utils';

type QueueRow = {
  id: string;
  name: string;
  status: string;
  subject?: string | null;
  pending: number;
  sent: number;
  failed: number;
  total: number;
  updatedAt: string;
};

function statusTone(status: string) {
  if (status === 'SENDING') return 'success' as const;
  if (status === 'PAUSED') return 'warning' as const;
  if (status === 'FAILED' || status === 'CANCELLED') return 'danger' as const;
  if (status === 'SENT') return 'info' as const;
  return undefined;
}

export function QueueConsolePage() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ campaigns: QueueRow[] }>('/api/campaigns/queue-console');
      setRows(data.campaigns);
    } catch (err) {
      toast.error('Could not load queue', err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [load]);

  async function pause(id: string) {
    setBusyId(id);
    try {
      await api.post(`/api/campaigns/${id}/pause`);
      toast.success('Campaign paused');
      await load();
    } catch (err) {
      toast.error('Pause failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function resume(id: string) {
    setBusyId(id);
    try {
      await api.post(`/api/campaigns/${id}/resume`);
      toast.success('Campaign resumed');
      await load();
    } catch (err) {
      toast.error('Resume failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function retryFailed(id: string) {
    setBusyId(id);
    try {
      const data = await api.post<{ retried: number }>(`/api/campaigns/${id}/retry-failed`);
      toast.success('Retrying failed', `${data.retried} recipient(s) re-queued`);
      await load();
    } catch (err) {
      toast.error('Retry failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4 font-mono">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-accent">ops · queue</p>
          <h1 className="page-title text-primary">Queue Console</h1>
          <p className="page-sub max-w-2xl">
            Live pending / sent / failed counts. Pause, resume, or retry failed recipients.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="tui-box overflow-x-auto">
        <div className="tui-box-title">Campaigns</div>
        <table className="w-full min-w-180 text-left text-xs">
          <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Campaign</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium tabular-nums">Pending</th>
              <th className="px-3 py-2 font-medium tabular-nums">Sent</th>
              <th className="px-3 py-2 font-medium tabular-nums">Failed</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/60 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <Link to={`/app/campaigns/${row.id}`} className="text-primary hover:underline">
                    {row.name}
                  </Link>
                  {row.subject ? (
                    <div className="truncate text-[10px] text-muted-foreground">{row.subject}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                </td>
                <td className="px-3 py-2 tabular-nums text-warning">{row.pending}</td>
                <td className="px-3 py-2 tabular-nums text-primary">{row.sent}</td>
                <td className="px-3 py-2 tabular-nums text-destructive">{row.failed}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {row.status === 'SENDING' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => void pause(row.id)}
                      >
                        <Pause className="h-3 w-3" /> Pause
                      </Button>
                    ) : null}
                    {row.status === 'PAUSED' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => void resume(row.id)}
                      >
                        <Play className="h-3 w-3" /> Resume
                      </Button>
                    ) : null}
                    {row.failed > 0 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === row.id}
                        onClick={() => void retryFailed(row.id)}
                        className={cn(row.status === 'SENDING' && 'opacity-90')}
                      >
                        <RotateCcw className="h-3 w-3" /> Retry failed
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && !loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No active or recent queue campaigns.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
