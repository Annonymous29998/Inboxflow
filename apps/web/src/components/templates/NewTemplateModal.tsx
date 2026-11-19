import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui';

interface NewTemplateModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; file: File | null }) => Promise<void>;
}

export function NewTemplateModal({ open, onClose, onCreate }: NewTemplateModalProps) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setFile(null);
    setError('');
    setSaving(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a template name');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await onCreate({ name: trimmed, file });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create template');
    } finally {
      setSaving(false);
    }
  }

  function onFileChange(next: File | null) {
    setFile(next);
    if (next && !name.trim()) {
      setName(next.name.replace(/\.(html|htm|mjml|txt)$/i, ''));
    }
  }

  return (
    <div className="mailer-root fixed inset-0 z-[85] flex items-center justify-center bg-black/70 px-4">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="Close" />

      <div className="mailer-panel relative z-10 w-full max-w-lg">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="flex items-start justify-between gap-4 border-b border-[var(--mailer-stroke)] px-5 py-4">
            <div>
              <p className="mailer-hint" style={{ marginTop: 0 }}>
                library · new
              </p>
              <h2 className="text-lg font-semibold uppercase tracking-wide text-primary">New template</h2>
              <p className="mailer-hint">Name it, import HTML / MJML, or start blank.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="border border-[var(--mailer-stroke)] p-2 text-[var(--mailer-dim)] hover:text-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mailer-pad space-y-4">
            <div>
              <Label>Template name</Label>
              <Input
                id="template-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Welcome email, Product launch"
                autoFocus
                disabled={saving}
              />
            </div>

            <div>
              <Label>Import HTML / MJML (optional)</Label>
              <div
                className="mt-1 flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-[var(--mailer-stroke)] bg-[#050805] px-4 py-6 text-center hover:border-[var(--color-accent)]"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFileChange(e.dataTransfer.files?.[0] ?? null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                }}
                role="button"
                tabIndex={0}
              >
                <Upload className="h-6 w-6 text-[var(--mailer-dim)]" />
                {file ? (
                  <>
                    <p className="text-sm font-medium text-primary">{file.name}</p>
                    <p className="mailer-hint" style={{ marginTop: 0 }}>
                      Click to choose a different file
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm">Drop or click to upload</p>
                    <p className="mailer-hint" style={{ marginTop: 0 }}>
                      .html, .htm, .mjml, .txt
                    </p>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                id="template-file"
                type="file"
                accept=".html,.htm,.mjml,.txt"
                className="sr-only"
                disabled={saving}
                onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
              />
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-[var(--mailer-stroke)] px-5 py-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating…
                </>
              ) : file ? (
                'Import template'
              ) : (
                'Create blank template'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
