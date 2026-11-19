import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, Label, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { contactImportRowsToText, parseContactImportRows } from '@/lib/parse-contact-import';

type Progress = {
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
};

const idleProgress: Progress = {
  total: 0,
  processed: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  status: 'idle',
  message: '',
};

export function CampaignImportRecipientsModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (list: { id: string; name: string; count: number }) => void;
}) {
  const [listName, setListName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>(idleProgress);
  const rows = useMemo(() => parseContactImportRows(text), [text]);
  const count = rows.length;
  const rawLines = useMemo(
    () => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('@')).length,
    [text],
  );
  const duplicatesRemoved = Math.max(0, rawLines - count);
  const pct = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;

  if (!open) return null;

  async function onFile(file: File) {
    setText(await file.text());
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const name = listName.trim();
    if (!name) {
      setError('Name this list');
      return;
    }
    if (!rows.length) {
      setError('Paste or import at least one email');
      return;
    }
    setBusy(true);
    const totalRows = rows.length;
    setProgress({
      total: totalRows,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      status: 'running',
      message: 'Preparing rows…',
    });
    try {
      const CHUNK = 200;
      let listId = '';
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let processed = 0;
      for (let i = 0, chunkIndex = 0; i < rows.length; i += CHUNK, chunkIndex++) {
        const slice = rows.slice(i, i + CHUNK);
        const result = await api.post<{
          listId?: string | null;
          created?: number;
          updated?: number;
          skipped?: number;
          total?: number;
        }>('/api/contacts/import', {
          content: contactImportRowsToText(slice),
          updateExisting: true,
          ...(listId ? { listId } : { listName: name }),
          chunkIndex,
          totalRows,
        });
        if (result.listId && !listId) listId = result.listId;
        created += result.created || 0;
        updated += result.updated || 0;
        skipped += result.skipped || 0;
        processed += result.total || slice.length;
        setProgress({
          total: totalRows,
          processed: Math.min(totalRows, processed),
          created,
          updated,
          skipped,
          status: 'running',
          message: `Imported ${Math.min(totalRows, processed)} of ${totalRows}…`,
        });
      }
      if (!listId) throw new Error('Import did not return a list');
      setProgress((p) => ({
        ...p,
        status: 'done',
        message: `Done · ${created} new, ${updated} updated, ${skipped} skipped`,
      }));
      onImported({ id: listId, name, count: created + updated || rows.length });
      setListName('');
      setText('');
      setProgress(idleProgress);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not import recipients';
      setError(msg);
      setProgress((p) => ({ ...p, status: 'error', message: msg }));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/75 p-4">
      <form className="tui-box w-full max-w-lg" onSubmit={(e) => void onSubmit(e)}>
        <div className="tui-box-title">Import contact list</div>
        <div className="space-y-3 p-4">
          <div>
            <Label>List name</Label>
            <Input
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="Name this list"
              disabled={busy}
            />
          </div>
          <div>
            <Label>Emails (one per line)</Label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-36 font-mono text-xs"
              placeholder="one@example.com"
              disabled={busy}
            />
            <p className="mailer-hint">
              {count} unique email{count === 1 ? '' : 's'}
              {duplicatesRemoved > 0
                ? ` · ${duplicatesRemoved} duplicate${duplicatesRemoved === 1 ? '' : 's'} removed`
                : ''}
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center border border-border px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground hover:text-primary">
            Import CSV / TXT
            <input
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void onFile(file);
              }}
            />
          </label>
          {progress.status !== 'idle' ? (
            <div className="border border-border bg-muted/40 p-3 text-xs">
              <div className="mb-1 flex justify-between font-medium">
                <span>Import status</span>
                <span>
                  {progress.processed} / {progress.total} ({pct}%)
                </span>
              </div>
              <div className="mb-2 h-1.5 w-full bg-border">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-muted-foreground">{progress.message}</p>
              {progress.created || progress.updated || progress.skipped ? (
                <p className="mt-1">
                  {progress.created} new · {progress.updated} updated · {progress.skipped} skipped
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
