import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Input, Label, Progress, Select } from '@/components/ui';
import { Download, FileUp, Plus, Search, Upload, AlertTriangle, Trash2, ListPlus, Users, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown, MinusSquare, PlusSquare } from 'lucide-react';
import { toast } from '@/stores/toast';
import { useDraft, useDraftStore } from '@/stores/draft';

type Contact = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINED' | 'CLEANED';
  source: string | null;
  createdAt: string;
  listMemberships?: Array<{ list?: { id: string; name: string } }>;
};

type ContactList = {
  id: string;
  name: string;
  description?: string;
  _count?: { members: number };
};

type ImportProgressState = {
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  addedToList: number;
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  listName: string;
  listId?: string | null;
  errors: string[];
};

const emptyImportProgress: ImportProgressState = {
  total: 0,
  processed: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  addedToList: 0,
  status: 'idle',
  message: '',
  listName: '',
  errors: [],
};

type Row = { email: string; firstName?: string; lastName?: string; phone?: string };

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return rows;
  const header = lines[0].split(/[,\t;]/).map((s) => s.trim().toLowerCase());
  const hasEmailHeader = header.includes('email') || header.includes('e-mail');
  const mapCol: Record<string, number> = {};
  header.forEach((h, i) => {
    if (h === 'email' || h === 'e-mail') mapCol.email = i;
    else if (h === 'firstname' || h === 'first_name' || h === 'first') mapCol.firstName = i;
    else if (h === 'lastname' || h === 'last_name' || h === 'last') mapCol.lastName = i;
    else if (h === 'phone' || h === 'mobile' || h === 'cell') mapCol.phone = i;
  });
  const startIdx = hasEmailHeader ? 1 : 0;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (let i = startIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.includes(',') || rawLine.includes('\t')) {
      const cols = rawLine.split(/[,\t;]/).map((s) => s.replace(/^"|"$/g, '').trim());
      let email: string | undefined;
      if (mapCol.email !== undefined) email = cols[mapCol.email];
      else {
        const found = cols.find((c) => emailRegex.test(c));
        if (found) email = found;
      }
      if (!email || !emailRegex.test(email)) continue;
      rows.push({
        email,
        firstName: mapCol.firstName !== undefined ? cols[mapCol.firstName] || undefined : undefined,
        lastName: mapCol.lastName !== undefined ? cols[mapCol.lastName] || undefined : undefined,
        phone: mapCol.phone !== undefined ? cols[mapCol.phone] || undefined : undefined,
      });
    } else {
      if (emailRegex.test(rawLine)) rows.push({ email: rawLine });
    }
  }
  return rows;
}

function rowsToText(rows: Row[]): string {
  const header = ['email', 'firstName', 'lastName', 'phone'];
  return [header.join(','), ...rows.map((r) => [r.email, r.firstName ?? '', r.lastName ?? '', r.phone ?? ''].join(','))].join('\n');
}

function listNameFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || `Imported ${new Date().toLocaleDateString()}`;
}

export function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState<number>(1);
  const [pages, setPages] = useState<number>(1);
  const pageLimit = 50;
  const [search, setSearch] = useDraft<string>('contacts:search', '');
  const [status, setStatus] = useDraft<string>('contacts:status', '');
  const [activeListId, setActiveListId] = useDraft<string>('contacts:activeListId', '');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showCreate, setShowCreate] = useDraft<boolean>('contacts:showCreate', false);
  const [showImport, setShowImport] = useDraft<boolean>('contacts:showImport', false);
  const [form, setForm] = useDraft('contacts:form', { email: '', firstName: '', lastName: '' });
  const [importText, setImportText] = useDraft<string>('contacts:importText', '');
  const [importFileName, setImportFileName] = useDraft<string>('contacts:importFileName', '');
  const [lists, setLists] = useState<ContactList[]>([]);
  const [listMode, setListMode] = useDraft<'none' | 'existing' | 'auto' | 'custom'>('contacts:listMode', 'auto');
  const [listId, setListId] = useDraft<string>('contacts:listId', '');
  const [newListName, setNewListName] = useDraft<string>('contacts:newListName', '');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgressState>(emptyImportProgress);
  const [clearingAll, setClearingAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    load();
    loadLists();
    const params = new URLSearchParams(window.location.search);
    const qList = params.get('listId');
    if (qList) setActiveListId(qList);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [activeListId, status, search]);

  useEffect(() => {
    // Apply filter/search/list changes through pagination API
    const id = window.setTimeout(() => {
      void load();
    }, 250);
    return () => window.clearTimeout(id);
  }, [page, activeListId, status, search]);

  useEffect(() => {
    // Defensive clamp: after pages shrinks (Clear All / filter), page may be out of range
    const maxPage = Math.max(1, pages);
    if (page > maxPage) setPage(maxPage);
  }, [page, pages]);

  const grouped = useMemo(() => {
    const byList = new Map<string, { id: string; name: string; members: Contact[] }>();
    const unassigned: Contact[] = [];
    for (const c of contacts) {
      const memberships = c.listMemberships?.length ? c.listMemberships : [];
      if (!memberships.length) {
        unassigned.push(c);
        continue;
      }
      for (const m of memberships) {
        const l = m.list;
        if (!l) continue;
        const key = l.id;
        if (!byList.has(key)) byList.set(key, { id: l.id, name: l.name, members: [] });
        byList.get(key)!.members.push(c);
      }
    }
    const groups = Array.from(byList.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (unassigned.length) {
      groups.push({ id: '__unassigned__', name: 'Unassigned', members: unassigned });
    }
    return groups;
  }, [contacts]);

  const visibleGroups = useMemo(() => {
    if (!activeListId) return grouped;
    return grouped.filter((g) => g.id === activeListId);
  }, [grouped, activeListId]);

  function toggle(listId: string) {
    setExpanded((s) => ({ ...s, [listId]: !(s[listId] ?? (grouped.length <= 6)) }));
  }

  function expandAll() {
    const next: Record<string, boolean> = {};
    for (const g of grouped) next[g.id] = true;
    setExpanded(next);
  }

  function collapseAll() {
    setExpanded({});
  }

  async function loadLists() {
    try {
      const data = await api.get<{ lists: ContactList[] }>('/api/lists');
      setLists(data.lists);
      if (!listId && data.lists[0] && listMode === 'existing') setListId(data.lists[0].id);
    } catch {
      /* ignore */
    }
  }

  async function load() {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      if (activeListId && activeListId !== '__unassigned__') params.set('listId', activeListId);
      if (page > 1) params.set('page', String(page));
      if (pageLimit) params.set('limit', String(pageLimit));
      const data = await api.get<{ contacts: Contact[]; total: number; page?: number; limit?: number; pages?: number }>(
        `/api/contacts${params.toString() ? `?${params.toString()}` : ''}`,
      );
      setContacts(data.contacts);
      setTotal(data.total);
      if (typeof data.pages === 'number') setPages(Math.max(1, data.pages));
      else setPages(Math.max(1, Math.ceil(data.total / (pageLimit || 50))));
      if (activeListId === '__unassigned__') {
        // Client-side filter: keep only contacts with zero listMemberships
        setContacts((prev) => prev.filter((c) => !c.listMemberships || c.listMemberships.length === 0));
        const visibleCount = data.contacts.filter((c) => !c.listMemberships || c.listMemberships.length === 0).length;
        const totalCount = data.total;
        // Unassigned total is approximate: take returned slice's unassigned count,
        // leave pages as-is from server (user can still paginate to find all).
        void visibleCount;
        void totalCount;
      }
    } catch (err) {
      toast.error('Could not load contacts', err instanceof Error ? err.message : undefined);
    }
  }

  async function createContact(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/api/contacts', { ...form, consent: true });
      setShowCreate(false);
      setForm({ email: '', firstName: '', lastName: '' });
      const clearDraft = useDraftStore.getState().clearDraft;
      clearDraft('contacts:showCreate');
      clearDraft('contacts:form');
      await load();
      await loadLists();
      toast.success('Contact created', form.email);
    } catch (err) {
      toast.error('Could not create contact', err instanceof Error ? err.message : undefined);
    }
  }

  async function clearAllContacts() {
    const hasFilter = !!activeListId || !!status;
    const visibleCount = contacts.length;
    if (total === 0 || visibleCount === 0) {
      toast.info('Nothing to clear');
      return;
    }
    const listLabel = activeListId
      ? activeListId === '__unassigned__'
        ? '"Unassigned"'
        : lists.find((l) => l.id === activeListId)?.name
          ? `"${lists.find((l) => l.id === activeListId)!.name}"`
          : 'this list'
      : null;
    const scopeLabel = hasFilter
      ? listLabel
        ? `contacts in list ${listLabel}${status ? ` with status "${status}"` : ''}`
        : status
          ? `all contacts with status "${status}"`
          : 'all visible filtered contacts'
      : `${total.toLocaleString()} contacts across ALL lists`;
    if (!confirm(`Are you sure you want to DELETE ${scopeLabel}? This cannot be undone.`)) return;
    if (!confirm(`Really? Type YES in your head. This permanently removes the contacts.`)) return;
    setClearingAll(true);
    try {
      const params = new URLSearchParams();
      params.set('confirm', 'yes');
      if (status) params.set('status', status);
      if (activeListId && activeListId !== '__unassigned__') params.set('listId', activeListId);
      const res = await api.delete<{ deleted: number }>(
        `/api/contacts${params.toString() ? `?${params.toString()}` : ''}`,
      );
      toast.success(
        `Deleted ${res.deleted} contacts` + (activeListId ? ` from ${activeListId === '__unassigned__' ? 'Unassigned' : lists.find((l) => l.id === activeListId)?.name || 'list'}` : ''),
      );
      setPage(1);
      await load();
      await loadLists();
    } catch (err) {
      toast.error('Could not delete contacts', err instanceof Error ? err.message : undefined);
    } finally {
      setClearingAll(false);
    }
  }

  async function deleteContact(id: string, email: string) {
    if (!confirm(`Delete contact ${email}?`)) return;
    try {
      await api.delete(`/api/contacts/${id}`);
      toast.success('Contact deleted');
      await load();
    } catch (err) {
      toast.error('Could not delete contact', err instanceof Error ? err.message : undefined);
    }
  }

  async function exportCSV() {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      if (activeListId && activeListId !== '__unassigned__') params.set('listId', activeListId);
      const blob = await api.blob(
        `/api/contacts/export/csv${params.toString() ? `?${params.toString()}` : ''}`,
      );
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast.success('Exported CSV');
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 15_000);
      }
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImportFileName(f.name);
    if (!newListName && listMode === 'auto') setNewListName(listNameFromFileName(f.name));
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ''));
    };
    reader.readAsText(f);
  }

  async function runImport() {
    const parsed = parseRows(importText);
    if (!parsed.length) {
      toast.error('No valid emails to import');
      return;
    }
    let finalListId: string | undefined | null;
    let finalListName = '';
    if (listMode === 'existing') {
      if (!listId) {
        toast.error('Select a list first');
        return;
      }
      finalListId = listId;
      const lst = lists.find((l) => l.id === listId);
      finalListName = lst?.name ?? '';
    } else if (listMode === 'auto' || listMode === 'custom') {
      const suggested = listMode === 'auto' && importFileName ? listNameFromFileName(importFileName) : newListName;
      finalListName = (suggested || '').trim();
      if (!finalListName) {
        toast.error('Enter a list name');
        return;
      }
    }
    setImporting(true);
    setProgress({
      total: parsed.length,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      addedToList: 0,
      status: 'running',
      message: 'Preparing rows…',
      listName: finalListName,
      errors: [],
    });
    try {
      const CHUNK = 80;
      let created = 0, updated = 0, skipped = 0, addedToList = 0, processed = 0;
      // First chunk may create the list; subsequent chunks reuse that listId.
      // We request list creation in the FIRST chunk only.
      for (let i = 0; i < parsed.length; i += CHUNK) {
        const slice = parsed.slice(i, i + CHUNK);
        const payload: {
          content: string;
          updateExisting: boolean;
          listId?: string;
          listName?: string;
        } = { content: rowsToText(slice), updateExisting: true };
        if (finalListId) payload.listId = finalListId;
        else if (finalListName) payload.listName = finalListName;
        const result = await api.post<{
          created: number;
          updated: number;
          skipped: number;
          addedToList: number;
          listId?: string | null;
          total: number;
          duplicates?: string[];
        }>('/api/contacts/import', payload);
        created += result.created || 0;
        updated += result.updated || 0;
        skipped += result.skipped || 0;
        addedToList += result.addedToList || 0;
        processed += result.total || slice.length;
        if (result.listId && !finalListId) finalListId = result.listId;
        if (finalListId && payload.listName) delete payload.listName;
        setProgress((p) => ({
          ...p,
          processed,
          created,
          updated,
          skipped,
          addedToList,
          listId: finalListId,
          message: `Imported ${processed} of ${parsed.length} rows…`,
        }));
      }
      setProgress((p) => ({
        ...p,
        status: 'done',
        processed,
        created,
        updated,
        skipped,
        addedToList,
        message: `Done! ${created} new, ${updated} updated, ${skipped} skipped${
          addedToList ? `, ${addedToList} added to list` : ''
        }`,
      }));
      const clearDraft = useDraftStore.getState().clearDraft;
      clearDraft('contacts:importText');
      clearDraft('contacts:importFileName');
      clearDraft('contacts:newListName');
      clearDraft('contacts:showImport');
      setImportText('');
      setImportFileName('');
      await load();
      await loadLists();
      toast.success(
        'Import complete',
        `${created} new, ${updated} updated, ${skipped} skipped${addedToList ? `, ${addedToList} in list` : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setProgress((p) => ({ ...p, status: 'error', message: `Import failed: ${msg}`, errors: [msg] }));
      toast.error('Import failed', msg);
    } finally {
      setImporting(false);
    }
  }

  const pct = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? 'person' : 'people'} in your audience
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={clearAllContacts}
            disabled={!total || clearingAll}
            className="text-destructive hover:bg-destructive/10"
          >
            {clearingAll ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Clear All
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
            <Upload className="mr-2 h-4 w-4" /> Import
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add Contact
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email, first name, last name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              className="pl-9"
            />
          </div>
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
            }}
            className="w-44"
          >
            <option value="">All statuses</option>
            <option value="SUBSCRIBED">Subscribed</option>
            <option value="UNSUBSCRIBED">Unsubscribed</option>
            <option value="BOUNCED">Bounced</option>
            <option value="COMPLAINED">Complained</option>
            <option value="CLEANED">Cleaned</option>
          </Select>
          <Select
            value={activeListId}
            onChange={(e) => {
              setActiveListId(e.target.value);
            }}
            className="w-52"
          >
            <option value="">All lists ({total.toLocaleString()})</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l._count?.members ?? 0})
              </option>
            ))}
            {grouped.some((g) => g.id === '__unassigned__') && (
              <option value="__unassigned__">
                Unassigned ({grouped.find((g) => g.id === '__unassigned__')?.members.length ?? 0})
              </option>
            )}
          </Select>
          <Button variant="outline" size="sm" onClick={expandAll} title="Expand all lists">
            <PlusSquare className="mr-2 h-4 w-4" /> Expand
          </Button>
          <Button variant="outline" size="sm" onClick={collapseAll} title="Collapse all lists">
            <MinusSquare className="mr-2 h-4 w-4" /> Collapse
          </Button>
          <Button variant="outline" size="sm" onClick={load}>
            Refresh
          </Button>
        </div>
      </Card>

      <div className="space-y-3">
        {visibleGroups.length === 0 && (
          <Card>
            <div className="px-4 py-16 text-center text-muted-foreground">
              <Users className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p className="text-base">No contacts yet</p>
              <p className="mt-1 text-xs">Click Import or Add Contact to grow your audience.</p>
            </div>
          </Card>
        )}
        {visibleGroups.map((g) => {
          const isOpen = expanded[g.id] ?? grouped.length <= 6;
          return (
            <Card key={g.id} className="overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(g.id)}
                className="flex w-full items-center gap-3 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/60"
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                )}
                <ListPlus className="h-4 w-4 flex-none text-violet-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="truncate font-semibold tracking-tight">{g.name}</h3>
                    <Badge tone="neutral">
                      {g.members.length} {g.members.length === 1 ? 'contact' : 'contacts'}
                    </Badge>
                  </div>
                  {g.members[0]?.email && (
                    <p className="truncate text-xs text-muted-foreground">
                      {g.members[0].email}
                      {g.members.length > 1 ? ` +${g.members.length - 1} more` : ''}
                    </p>
                  )}
                </div>
              </button>
              {isOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">Email</th>
                        <th className="px-4 py-3 text-left font-medium">Name</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                        <th className="px-4 py-3 text-left font-medium">Lists</th>
                        <th className="px-4 py-3 text-left font-medium">Added</th>
                        <th className="px-4 py-3 text-right font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.members.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10 text-center text-xs text-muted-foreground">
                            No contacts in this list.
                          </td>
                        </tr>
                      )}
                      {g.members.map((c) => (
                        <tr key={c.id + g.id} className="border-t border-border hover:bg-muted/30">
                          <td className="px-4 py-3 font-medium">{c.email}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                          </td>
                          <td className="px-4 py-3">
                            <Badge tone={c.status === 'SUBSCRIBED' ? 'success' : 'neutral'} className="capitalize">
                              {c.status.toLowerCase()}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {c.listMemberships?.length
                              ? c.listMemberships
                                  .slice(0, 2)
                                  .map((m) => m.list?.name)
                                  .filter(Boolean)
                                  .join(', ') +
                                (c.listMemberships.length > 2 ? ` +${c.listMemberships.length - 2}` : '')
                              : '—'}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {new Date(c.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deleteContact(c.id, c.email)}
                              className="text-muted-foreground transition-colors hover:text-destructive"
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {total > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Showing <span className="font-medium text-foreground">{contacts.length}</span> of{' '}
              <span className="font-medium text-foreground">{total.toLocaleString()}</span> contact
              {total === 1 ? '' : 's'}
              {activeListId ? ` in this view` : ''} · Page{' '}
              <span className="font-medium text-foreground">{Math.min(page, pages)}</span> of{' '}
              <span className="font-medium text-foreground">{pages}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(1)}
                disabled={page <= 1}
              >
                « First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ‹ Prev
              </Button>
              <div className="hidden items-center gap-1 md:flex">
                {((): number[] => {
                  if (pages <= 7) {
                    return Array.from({ length: pages }, (_, i) => i + 1);
                  }
                  const start = page <= 4 ? 1 : page >= pages - 3 ? pages - 6 : page - 3;
                  const out: number[] = [];
                  for (let i = 0; i < 7; i++) {
                    const t = start + i;
                    if (t >= 1 && t <= pages) out.push(t);
                  }
                  return out;
                })().map((target) => (
                  <Button
                    key={target}
                    size="sm"
                    variant={target === page ? 'primary' : 'outline'}
                    onClick={() => setPage(target)}
                  >
                    {target}
                  </Button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
              >
                Next ›
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(pages)}
                disabled={page >= pages}
              >
                Last »
              </Button>
            </div>
          </div>
        </Card>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-md p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Add contact</h2>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground">
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={createContact} className="space-y-3">
              <div>
                <Label>Email *</Label>
                <Input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="name@company.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>First name</Label>
                  <Input
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Last name</Label>
                  <Input
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button type="submit">Add Contact</Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-2xl p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Import contacts</h2>
                <p className="text-sm text-muted-foreground">
                  Paste text, or upload a CSV / TXT file. Emails are deduplicated automatically.
                </p>
              </div>
              <button onClick={() => setShowImport(false)} className="text-muted-foreground hover:text-foreground">
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label className="mb-2 inline-block">Add to a list</Label>
                <Select value={listMode} onChange={(e) => setListMode(e.target.value as typeof listMode)}>
                  <option value="auto">Auto-name from filename</option>
                  <option value="custom">Name it myself</option>
                  <option value="existing">Add to existing list</option>
                  <option value="none">Don't add to a list</option>
                </Select>
              </div>

              {listMode === 'existing' && (
                <div>
                  <Label className="mb-2 inline-block">Choose list</Label>
                  <Select value={listId} onChange={(e) => setListId(e.target.value)}>
                    <option value="">Select a list…</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l._count?.members ?? 0})
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {(listMode === 'auto' || listMode === 'custom') && (
                <div>
                  <Label className="mb-2 inline-block">
                    <ListPlus className="mr-1 inline h-3.5 w-3.5" />
                    {listMode === 'auto' ? 'New list name (auto-filled from file)' : 'New list name'}
                  </Label>
                  <Input
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder={listMode === 'auto' ? 'Type name or upload a CSV…' : 'e.g. Website signups Nov 26'}
                  />
                </div>
              )}
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className="mr-2 h-4 w-4" />
                {importFileName ? `Replace: ${importFileName}` : 'Choose CSV / TXT file'}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,.tsv"
                onChange={onPickFile}
                className="hidden"
              />
              {importFileName && (
                <Badge tone="neutral" className="gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" /> {importFileName}
                </Badge>
              )}
            </div>

            <div>
              <Label className="mb-2 inline-block">Emails (one per line, or CSV)</Label>
              <textarea
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={
                  'email,firstName,lastName\njane@company.com,Jane,Doe\nsales@acme.io'
                }
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  if (!importFileName && !newListName && listMode !== 'none') {
                    setNewListName(`Paste import ${new Date().toLocaleDateString()}`);
                  }
                }}
              />
              {importText && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Detected <span className="font-medium text-foreground">{parseRows(importText).length}</span> valid
                  email rows
                </p>
              )}
            </div>

            {(progress.status !== 'idle' || importing) && (
              <div className="mt-5 rounded-lg border border-border bg-muted/40 p-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {progress.status === 'done' && '✅ '}
                    {progress.status === 'error' && '❌ '}
                    Import status
                  </span>
                  <span className="text-muted-foreground">
                    {progress.processed} / {progress.total} ({pct}%)
                  </span>
                </div>
                <Progress value={pct} className="mb-2 h-2" />
                <p className="text-sm text-muted-foreground">{progress.message || 'Preparing…'}</p>
                {(progress.created || progress.updated || progress.skipped || progress.addedToList) ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                    <div className="rounded bg-background p-2">
                      <div className="text-emerald-500/90 font-semibold">{progress.created}</div>
                      <div className="text-muted-foreground">New</div>
                    </div>
                    <div className="rounded bg-background p-2">
                      <div className="text-sky-500/90 font-semibold">{progress.updated}</div>
                      <div className="text-muted-foreground">Updated</div>
                    </div>
                    <div className="rounded bg-background p-2">
                      <div className="text-amber-500/90 font-semibold">{progress.skipped}</div>
                      <div className="text-muted-foreground">Skipped</div>
                    </div>
                    <div className="rounded bg-background p-2">
                      <div className="text-violet-500/90 font-semibold">{progress.addedToList}</div>
                      <div className="text-muted-foreground">Added to list</div>
                    </div>
                  </div>
                ) : null}
                {progress.listName && progress.status !== 'error' && (
                  <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-background px-2.5 py-1 text-xs">
                    <ListPlus className="h-3.5 w-3.5 text-violet-400" /> List:
                    <span className="font-medium">{progress.listName}</span>
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowImport(false)}
                disabled={importing}
              >
                Close
              </Button>
              <Button
                type="button"
                onClick={runImport}
                disabled={importing || !parseRows(importText).length}
              >
                {importing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" /> Import{' '}
                    {parseRows(importText).length ? `${parseRows(importText).length} rows` : ''}
                  </>
                )}
              </Button>
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-300/30 bg-amber-500/5 p-3 text-xs text-amber-700/90 dark:text-amber-300/80">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <div>
                Tip: After import, your new list is automatically available in the Campaign editor under{' '}
                <span className="font-medium">Recipients → Lists</span>. You can also delete entire lists from{' '}
                <span className="font-medium">Settings → Lists</span>.
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
