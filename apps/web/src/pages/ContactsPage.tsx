import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Input, Label, Select } from '@/components/ui';
import { Download, FileUp, Plus, Search, Upload } from 'lucide-react';
import { toast } from '@/stores/toast';

type Contact = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  status: string;
  tagAssignments?: Array<{ tag: { name: string; color: string } }>;
};

type ContactList = { id: string; name: string; _count?: { members: number } };

const ACCEPTED_IMPORT =
  '.csv,.txt,.tsv,.json,.md,.html,.xml,.log,text/csv,text/plain,application/json';

export function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '' });
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [lists, setLists] = useState<ContactList[]>([]);
  const [listMode, setListMode] = useState<'none' | 'existing' | 'new'>('existing');
  const [listId, setListId] = useState('');
  const [newListName, setNewListName] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const q = new URLSearchParams();
    if (search) q.set('search', search);
    if (status) q.set('status', status);
    const data = await api.get<{ contacts: Contact[]; total: number }>(`/api/contacts?${q}`);
    setContacts(data.contacts);
    setTotal(data.total);
  }

  async function loadLists() {
    const data = await api.get<{ lists: ContactList[] }>('/api/lists');
    setLists(data.lists);
    if (data.lists[0] && !listId) setListId(data.lists[0].id);
  }

  useEffect(() => {
    load().catch(console.error);
  }, [status]);

  useEffect(() => {
    if (showImport) loadLists().catch(console.error);
  }, [showImport]);

  async function createContact(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/api/contacts', { ...form, consent: true });
      setShowCreate(false);
      setForm({ email: '', firstName: '', lastName: '' });
      await load();
      toast.success('Contact created', form.email);
    } catch (err) {
      toast.error('Could not create contact', err instanceof Error ? err.message : undefined);
    }
  }

  async function readFile(file: File) {
    const text = await file.text();
    setImportText(text);
    setImportFileName(file.name);
  }

  async function importContacts(e: React.FormEvent) {
    e.preventDefault();
    if (!importText.trim()) {
      toast.warning('Choose a file or paste text containing email addresses');
      return;
    }
    setImporting(true);
    try {
      const payload: {
        content: string;
        listId?: string;
        listName?: string;
      } = { content: importText };

      if (listMode === 'existing' && listId) payload.listId = listId;
      if (listMode === 'new' && newListName.trim()) payload.listName = newListName.trim();

      const result = await api.post<{
        created: number;
        updated: number;
        skipped: number;
        addedToList: number;
        total: number;
        listId: string | null;
      }>('/api/contacts/import', payload);

      const listNote =
        result.addedToList > 0 ? ` · ${result.addedToList} added to list` : '';
      toast.success(
        'Import complete',
        `${result.total} emails: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped${listNote}`,
      );
      setShowImport(false);
      setImportText('');
      setImportFileName('');
      setNewListName('');
      await load();
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : undefined);
    } finally {
      setImporting(false);
    }
  }

  async function exportCsv() {
    const res = await fetch('/api/contacts/export/csv', {
      credentials: 'include',
      headers: {
        ...(api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {}),
      },
    });
    if (!res.ok) {
      toast.error('Export failed', 'Try signing in again');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Contacts exported');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Contacts</h1>
          <p className="page-sub">{total} contacts in your CRM</p>
        </div>
        <div className="page-toolbar">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
            <Upload className="h-4 w-4" /> <span className="hidden sm:inline">Import</span>
            <span className="sm:hidden">Import</span>
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-3 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-ink-muted" />
            <Input
              className="pl-9"
              placeholder="Search email or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-48">
            <option value="">All statuses</option>
            <option value="SUBSCRIBED">Subscribed</option>
            <option value="UNSUBSCRIBED">Unsubscribed</option>
            <option value="BOUNCED">Bounced</option>
            <option value="COMPLAINED">Complained</option>
          </Select>
          <Button variant="secondary" onClick={load}>
            Filter
          </Button>
        </div>

        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-ink-muted">
                <th className="pb-3">Email</th>
                <th className="pb-3">Name</th>
                <th className="pb-3">Status</th>
                <th className="pb-3">Tags</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b border-border/50">
                  <td className="py-3 font-medium">{c.email}</td>
                  <td className="text-ink-muted">
                    {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td>
                    <Badge tone={c.status === 'SUBSCRIBED' ? 'success' : c.status === 'BOUNCED' ? 'danger' : 'neutral'}>
                      {c.status}
                    </Badge>
                  </td>
                  <td className="space-x-1">
                    {c.tagAssignments?.map((t) => (
                      <Badge key={t.tag.name}>{t.tag.name}</Badge>
                    ))}
                  </td>
                </tr>
              ))}
              {!contacts.length ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-ink-muted">
                    <p className="mb-3">No contacts yet. Add one or import a file with email addresses.</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="sm" onClick={() => setShowCreate(true)}>
                        <Plus className="h-4 w-4" /> Add contact
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
                        <Upload className="h-4 w-4" /> Import
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {showCreate && (
        <Modal title="Add contact" onClose={() => setShowCreate(false)}>
          <form onSubmit={createContact} className="space-y-3">
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>First name (optional)</Label>
                <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </div>
              <div>
                <Label>Last name (optional)</Label>
                <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </div>
            </div>
            <Button type="submit" className="w-full">
              Save contact
            </Button>
          </form>
        </Modal>
      )}

      {showImport && (
        <Modal title="Import contacts" onClose={() => setShowImport(false)}>
          <form onSubmit={importContacts} className="space-y-4">
            <p className="text-sm text-ink-muted">
              Upload a file or paste text from any document. Only email addresses are required — names are optional
              and will be filled in when available.
            </p>

            <div
              className="cursor-pointer border border-dashed border-border bg-muted/40 px-4 py-8 text-center transition-colors hover:border-primary/50"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) void readFile(file);
              }}
              onClick={() => fileRef.current?.click()}
            >
              <FileUp className="mx-auto mb-2 h-8 w-8 text-primary" />
              <p className="text-sm font-medium">Drop a file here or click to browse</p>
              <p className="mt-1 text-xs text-muted-foreground">
                CSV, TXT, TSV, JSON — or paste from Word, Excel, notes, etc.
              </p>
              {importFileName ? (
                <p className="mt-2 text-xs text-primary">{importFileName}</p>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED_IMPORT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
            </div>

            <div>
              <Label>Or paste emails / document text</Label>
              <textarea
                className="mt-1.5 h-32 w-full border border-border bg-muted p-3 font-mono text-xs"
                placeholder={`one@example.com\nanother@example.com\n\nOr paste a whole document — emails are detected automatically`}
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setImportFileName('');
                }}
              />
            </div>

            <div className="space-y-2 border border-border p-3">
              <Label>Add imported contacts to a list</Label>
              <Select
                value={listMode}
                onChange={(e) => setListMode(e.target.value as 'none' | 'existing' | 'new')}
              >
                <option value="existing">Existing list</option>
                <option value="new">Create new list</option>
                <option value="none">Contacts only (no list)</option>
              </Select>
              {listMode === 'existing' ? (
                <Select value={listId} onChange={(e) => setListId(e.target.value)}>
                  {!lists.length ? <option value="">No lists yet — create one below</option> : null}
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l._count?.members ?? 0} members)
                    </option>
                  ))}
                </Select>
              ) : null}
              {listMode === 'new' ? (
                <Input
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="New list name"
                  required
                />
              ) : null}
            </div>

            <Button type="submit" className="w-full" disabled={importing || !importText.trim()}>
              {importing ? 'Importing…' : 'Import contacts'}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="tui-box max-h-[92dvh] w-full max-w-lg overflow-y-auto border-border bg-card p-4 shadow-xl sm:max-w-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="page-title text-xl sm:text-2xl">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-border text-muted-foreground hover:text-primary"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
