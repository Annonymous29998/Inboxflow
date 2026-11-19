import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, Label } from '@/components/ui';

export function CampaignLetterImportModal({
  open,
  importing,
  onClose,
  onImportFile,
}: {
  open: boolean;
  importing?: boolean;
  onClose: () => void;
  onImportFile: (file: File, name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');

  if (!open) return null;

  function fromFile(next: File) {
    setFile(next);
    setError('');
    const stem = next.name.replace(/\.(html|htm|mjml|txt)$/i, '').trim();
    if (!name.trim()) setName(stem || 'Imported letter');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Choose an HTML or MJML file');
      return;
    }
    const letterName = name.trim() || file.name.replace(/\.(html|htm|mjml|txt)$/i, '').trim() || 'Imported letter';
    setError('');
    try {
      await onImportFile(file, letterName);
      onClose();
      setFile(null);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import letter');
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/75 p-4">
      <form className="tui-box w-full max-w-md" onSubmit={(e) => void onSubmit(e)}>
        <div className="tui-box-title">Import letter</div>
        <div className="space-y-3 p-4">
          <div>
            <Label>Letter name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Welcome letter"
            />
          </div>
          <label className="flex cursor-pointer items-center justify-center border border-primary px-3 py-5 text-sm font-bold uppercase tracking-wide text-primary">
            {file ? file.name : 'Choose HTML / MJML file'}
            <input
              type="file"
              accept=".html,.htm,.mjml,.txt,text/html"
              className="sr-only"
              disabled={importing}
              onChange={(e) => {
                const next = e.target.files?.[0];
                e.target.value = '';
                if (next) fromFile(next);
              }}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={importing}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={importing}>
              {importing ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
