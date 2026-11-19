import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { Badge, Button, Input, Label, PageLoading, Progress, Select } from '@/components/ui';
import { Download, FileUp, Plus, Search, Upload, AlertTriangle, Trash2, ListPlus, Users, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from '@/stores/toast';
import { confirmDialog } from '@/stores/confirm';
import { useDraft, useDraftStore } from '@/stores/draft';
import {
  contactImportRowsToText,
  parseContactImportRows,
  type ContactImportRow,
} from '@/lib/parse-contact-import';
import { uiCacheGet, uiCacheSet } from '@/lib/ui-cache';

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

type Row = ContactImportRow;

export function ContactsPage() {
  const cachedLists = uiCacheGet<ContactList[]>('lists') ?? [];
  const cachedContacts = uiCacheGet<{ contacts: Contact[]; total: number }>('contacts:home');
  const [contacts, setContacts] = useState<Contact[]>(() => cachedContacts?.contacts ?? []);
  const [loading, setLoading] = useState(() => !cachedContacts?.contacts.length && !cachedLists.length);
  const [total, setTotal] = useState(() => cachedContacts?.total ?? 0);
  const [page, setPage] = useState<number>(1);
  const [pages, setPages] = useState<number>(1);
  const pageLimit = 50;
  const [search, setSearch] = useDraft<string>('contacts:search', '');
  const [status, setStatus] = useDraft<string>('contacts:status', '');
  const [activeListId, setActiveListId] = useDraft<string>('contacts:activeListId', '');
  const [showCreate, setShowCreate] = useDraft<boolean>('contacts:showCreate', false);
  const [showImport, setShowImport] = useDraft<boolean>('contacts:showImport', false);
  const [form, setForm] = useDraft('contacts:form', { email: '', firstName: '', lastName: '' });
  const [importText, setImportText] = useDraft<string>('contacts:importText', '');
  const [importFileName, setImportFileName] = useDraft<string>('contacts:importFileName', '');
  const [lists, setLists] = useState<ContactList[]>(() => cachedLists);
  const [listMode, setListMode] = useDraft<'none' | 'existing' | 'custom'>('contacts:listMode', 'custom');
  const [listId, setListId] = useDraft<string>('contacts:listId', '');
  const [newListName, setNewListName] = useDraft<string>('contacts:newListName', '');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgressState>(emptyImportProgress);
  const [clearingAll, setClearingAll] = useState(false);
  const [listModal, setListModal] = useState<{ id: string; name: string } | null>(null);
  const [modalContacts, setModalContacts] = useState<Contact[]>([]);
  const [modalPage, setModalPage] = useState(1);
  const [modalPages, setModalPages] = useState(1);
  const [modalTotal, setModalTotal] = useState(0);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalSearch, setModalSearch] = useState('');
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
    // Always show every saved list (including empty ones) so they can be deleted
    for (const l of lists) {
      byList.set(l.id, { id: l.id, name: l.name, members: [] });
    }
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
  }, [contacts, lists]);

  const visibleGroups = useMemo(() => {
    if (!activeListId) return grouped;
    return grouped.filter((g) => g.id === activeListId);
  }, [grouped, activeListId]);

  const parsedRows = useMemo(() => parseContactImportRows(importText || ''), [importText]);
  const parsedCount = parsedRows.length;
  const rawEmailLines = useMemo(() => {
    const lines = (importText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.filter((l) => l.includes('@')).length;
  }, [importText]);
  const duplicatesRemoved = Math.max(0, rawEmailLines - parsedCount);
  const needsListName = listMode !== 'existing' && listMode !== 'none';
  const importDisabled =
    importing || parsedCount === 0 || (needsListName && !newListName.trim()) || (listMode === 'existing' && !listId);

  async function loadListMembers(listId: string, pageNum = 1, q = '') {
    setModalLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('listId', listId);
      params.set('page', String(pageNum));
      params.set('limit', '100');
      if (q.trim()) params.set('search', q.trim());
      if (status) params.set('status', status);
      const data = await api.get<{
        contacts: Contact[];
        total: number;
        page?: number;
        pages?: number;
      }>(`/api/contacts?${params.toString()}`);
      setModalContacts(Array.isArray(data.contacts) ? data.contacts : []);
      setModalTotal(data.total);
      setModalPages(Math.max(1, data.pages ?? Math.ceil(data.total / 100)));
      setModalPage(data.page ?? pageNum);
    } catch (err) {
      toast.error('Could not load list', err instanceof Error ? err.message : undefined);
    } finally {
      setModalLoading(false);
    }
  }

  function openListModal(id: string, name: string) {
    setListModal({ id, name });
    setModalSearch('');
    setModalPage(1);
    setModalContacts([]);
    void loadListMembers(id, 1, '');
  }

  async function loadLists() {
    try {
      const data = await api.get<{ lists: ContactList[] }>('/api/lists');
      setLists(Array.isArray(data.lists) ? data.lists : []);
      uiCacheSet('lists', data.lists);
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
      setContacts(Array.isArray(data.contacts) ? data.contacts : []);
      setTotal(Number(data.total) || 0);
      if (page === 1 && !search && !status && !activeListId) {
        uiCacheSet('contacts:home', { contacts: data.contacts, total: data.total });
      }
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
    } finally {
      setLoading(false);
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
    if (!(await confirmDialog({
      title: `Delete ${scopeLabel}`,
      description: `You are about to DELETE ${scopeLabel}.\n\nThis action cannot be undone — all rows are permanently removed from your audience.`,
      tone: 'danger',
      destructive: true,
      confirmText: `Yes, delete ${scopeLabel.split(' ')[0] || 'contacts'}`,
    }))) return;
    if (!(await confirmDialog({
      title: `Final confirmation`,
      description: `This is your last warning. Once confirmed, ${scopeLabel.toLowerCase()} will be PERMANENTLY erased from the database and cannot be recovered.\n\nAre you absolutely sure?`,
      tone: 'danger',
      destructive: true,
      confirmText: 'Permanently delete',
    }))) return;
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
    if (!(await confirmDialog({
      title: 'Delete contact',
      description: `Permanently delete <${email}> from your audience?\n\nThis cannot be undone.`,
      tone: 'danger',
      destructive: true,
      confirmText: 'Delete contact',
    }))) return;
    try {
      await api.delete(`/api/contacts/${id}`);
      toast.success('Contact deleted');
      await load();
      if (listModal) await loadListMembers(listModal.id, modalPage, modalSearch);
    } catch (err) {
      toast.error('Could not delete contact', err instanceof Error ? err.message : undefined);
    }
  }

  async function deleteList(listId: string, listName: string, memberCount: number) {
    if (listId === '__unassigned__') {
      toast.info('Unassigned is not a real list — delete contacts individually or use Clear All');
      return;
    }
    if (!(await confirmDialog({
      title: `Delete list “${listName}”`,
      description:
        memberCount > 0
          ? `This deletes the list and permanently deletes the ${memberCount.toLocaleString()} contact${memberCount === 1 ? '' : 's'} in it.\n\nContacts that also belong to other lists stay in those lists.\n\nThis cannot be undone.`
          : `This removes the list “${listName}”. If it still has members on the server, those contacts are deleted too.\n\nThis cannot be undone.`,
      tone: 'danger',
      destructive: true,
      confirmText: memberCount > 0 ? 'Delete list + contacts' : 'Delete list',
    }))) return;
    try {
      const res = await api.delete<{ success: boolean; contactsDeleted?: number }>(
        `/api/lists/${listId}?deleteContacts=true`,
      );
      toast.success(
        res.contactsDeleted
          ? `Deleted list and ${res.contactsDeleted} contact${res.contactsDeleted === 1 ? '' : 's'}`
          : 'List deleted',
      );
      if (activeListId === listId) setActiveListId('');
      setPage(1);
      await load();
      await loadLists();
    } catch (err) {
      toast.error('Could not delete list', err instanceof Error ? err.message : undefined);
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
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ''));
    };
    reader.readAsText(f);
  }

  async function runImport() {
    const parsed = parsedRows;
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
    } else if (listMode !== 'none') {
      finalListName = newListName.trim();
      if (!finalListName) {
        toast.error('Name this list');
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
    let streamCancel: { cancel: () => void } | null = null;
    try {
      const uuidFn =
        (globalThis as any).crypto?.randomUUID?.bind((globalThis as any).crypto) ??
        (() => {
          const s = 'abcdef0123456789';
          const rnd = (n: number) =>
            Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
          return `${rnd(8)}-${rnd(4)}-4${rnd(3)}-a${rnd(3)}-${rnd(12)}`;
        });
      const jobId = uuidFn();
      const totalRows = parsed.length;
      let chunkListIdCreated: string | null | undefined = undefined;

      streamCancel = api.events(`/api/jobs/${jobId}/stream`, {
        onEvent: (evt, d) => {
          if (evt !== 'job' || !d || typeof d !== 'object') return;
          const meta = (d.meta as any) ?? {};
          setProgress((prev) => ({
            ...prev,
            total: Math.max(prev.total, Number(d.total) ?? prev.total),
            processed: Math.min(Math.max(prev.processed, Number(d.processed) ?? 0), prev.total),
            created: Math.max(prev.created, Number(meta.created ?? 0)),
            updated: Math.max(prev.updated, Number(meta.updated ?? 0)),
            skipped: Math.max(prev.skipped, Number(meta.skipped ?? 0)),
            addedToList: Math.max(prev.addedToList, Number(meta.addedToList ?? 0)),
            listId: meta.listId ?? chunkListIdCreated ?? prev.listId,
            status:
              d.status === 'COMPLETED'
                ? 'done'
                : d.status === 'FAILED'
                  ? 'error'
                  : d.status === 'CANCELLED'
                    ? 'error'
                    : 'running',
            message:
              d.status === 'COMPLETED'
                ? 'Import complete'
                : d.status === 'FAILED'
                  ? String(d.error || 'Import failed')
                  : `Importing rows… ${Math.round(d.percent ?? 0)}%`,
            errors: d.error ? [String(d.error)] : prev.errors,
          }));
        },
        onError: (err) => {
          setProgress((p) => ({
            ...p,
            status: 'error',
            message: String(err?.message || 'Progress stream failed'),
            errors: [String(err?.message || 'Stream error')],
          }));
        },
      });

      // Larger chunks = fewer round-trips through the desktop→Lightsail proxy
      const CHUNK = 200;
      let chunkIndex = 0;
      let created = 0, updated = 0, skipped = 0, addedToList = 0, processed = 0;
      async function postChunk(payload: unknown, attempt = 0): Promise<{
        created: number;
        updated: number;
        skipped: number;
        addedToList: number;
        listId?: string | null;
        total: number;
        duplicates?: string[];
        jobId?: string | null;
      }> {
        try {
          return await api.post('/api/contacts/import', payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const retryable = /rate limit|too many requests|429|internal server error|502|503|504/i.test(msg);
          if (retryable && attempt < 6) {
            const waitMs = Math.min(20_000, 2_000 * (attempt + 1));
            setProgress((p) => ({
              ...p,
              message: `Server busy — retrying chunk in ${Math.round(waitMs / 1000)}s…`,
            }));
            await new Promise((r) => window.setTimeout(r, waitMs));
            return postChunk(payload, attempt + 1);
          }
          throw err;
        }
      }
      for (let i = 0; i < parsed.length; i += CHUNK, chunkIndex++) {
        const slice = parsed.slice(i, i + CHUNK);
        const payload: {
          content: string;
          updateExisting: boolean;
          listId?: string;
          listName?: string;
          jobId: string;
          chunkIndex: number;
          totalRows: number;
        } = {
          content: contactImportRowsToText(slice),
          updateExisting: true,
          jobId,
          chunkIndex,
          totalRows,
        };
        if (finalListId) payload.listId = finalListId;
        else if (finalListName && chunkIndex === 0) payload.listName = finalListName;
        else if (finalListName && !finalListId) {
          throw new Error('List was not created on the first import chunk — retry the import');
        }
        const result = await postChunk(payload);
        created += result.created || 0;
        updated += result.updated || 0;
        skipped += result.skipped || 0;
        addedToList += result.addedToList || 0;
        processed += result.total || slice.length;
        if (result.listId && !finalListId && !chunkListIdCreated) {
          finalListId = result.listId;
          chunkListIdCreated = result.listId;
          setProgress((p) => ({ ...p, listId: result.listId }));
        }
        setProgress((p) => ({
          ...p,
          processed: Math.min(totalRows, Math.max(p.processed, processed)),
          created: Math.max(p.created, created),
          updated: Math.max(p.updated, updated),
          skipped: Math.max(p.skipped, skipped),
          addedToList: Math.max(p.addedToList, addedToList),
          listId: chunkListIdCreated ?? finalListId ?? p.listId,
          message: `Imported ${processed} of ${totalRows} rows…`,
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
      setShowImport(false);
      if (finalListId) {
        setActiveListId(finalListId);
        setPage(1);
      }
      await loadLists();
      if (!finalListId) await load();
      toast.success(
        'Import complete',
        `${created} new, ${updated} updated, ${skipped} skipped${addedToList ? `, ${addedToList} in list` : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setProgress((p) => ({ ...p, status: 'error', message: `Import failed: ${msg}`, errors: [msg] }));
      toast.error('Import failed', msg);
    } finally {
      try { streamCancel?.cancel(); } catch {}
      streamCancel = null;
      setImporting(false);
    }
  }

  const pct = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="mailer-root page-root space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="mailer-hint" style={{ marginTop: 0 }}>
            audience · contacts
          </p>
          <h1 className="page-title text-primary">Contacts</h1>
          <p className="page-sub">
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

      <div className="mailer-panel">
        <div className="mailer-pad flex flex-wrap items-center gap-3">
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
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <PageLoading label="Loading contacts…" />
        ) : visibleGroups.length === 0 ? (
          <div className="mailer-panel">
            <div className="mailer-pad py-12 text-center">
              <Users className="mx-auto mb-3 h-8 w-8 text-[var(--mailer-dim)]" />
              <p className="text-primary">No contacts yet</p>
              <p className="mailer-hint">Import a CSV or add a contact to grow your audience.</p>
            </div>
          </div>
        ) : null}
        {!loading && visibleGroups.map((g) => {
          const listTotal =
            g.id === '__unassigned__'
              ? g.members.length
              : (lists.find((l) => l.id === g.id)?._count?.members ?? g.members.length);
          const canOpen = g.id !== '__unassigned__';
          return (
            <div key={g.id} className="camp-row w-full">
              <button
                type="button"
                className="camp-row-main text-left"
                onClick={() => {
                  if (canOpen) openListModal(g.id, g.name);
                }}
              >
                <strong>{g.name}</strong>
                <div className="meta">
                  {`${listTotal.toLocaleString()} ${listTotal === 1 ? 'contact' : 'contacts'}`}
                  {canOpen ? ' · View list' : ''}
                </div>
              </button>
              <div className="camp-row-actions">
                {canOpen ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => openListModal(g.id, g.name)}>
                    View list
                  </Button>
                ) : null}
                {canOpen ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    title="Delete this list"
                    onClick={() => void deleteList(g.id, g.name, listTotal)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete list
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {total > 0 && (
        <div className="mailer-panel">
          <div className="mailer-pad flex flex-wrap items-center justify-between gap-3">
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
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="mailer-panel w-full max-w-md">
            <div className="mailer-pad">
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
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="mailer-panel w-full max-w-2xl">
            <div className="mailer-pad">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Import contacts</h2>
                <p className="text-sm text-muted-foreground">
                  Paste text, or upload a CSV / TXT file. Trailing junk (like .Read) is cleaned and
                  duplicate emails are imported only once.
                </p>
              </div>
              <button onClick={() => setShowImport(false)} className="text-muted-foreground hover:text-foreground">
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label className="mb-2 inline-block">Add to a list</Label>
                <Select
                  value={listMode === 'existing' || listMode === 'none' ? listMode : 'custom'}
                  onChange={(e) => setListMode(e.target.value as typeof listMode)}
                >
                  <option value="custom">Name this list</option>
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

              {listMode !== 'existing' && listMode !== 'none' && (
                <div>
                  <Label className="mb-2 inline-block">
                    <ListPlus className="mr-1 inline h-3.5 w-3.5" />
                    List name
                  </Label>
                  <Input
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder="Name this list"
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
                }}
              />
              {importText && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Detected{' '}
                  <span className={'font-medium ' + (parsedCount === 0 ? 'text-red-400' : 'text-emerald-400')}>
                    {parsedCount}
                  </span>{' '}
                  unique email{parsedCount === 1 ? '' : 's'}
                  {duplicatesRemoved > 0 ? (
                    <>
                      {' '}
                      ·{' '}
                      <span className="font-medium text-amber-400">{duplicatesRemoved}</span> duplicate
                      {duplicatesRemoved === 1 ? '' : 's'} removed
                    </>
                  ) : null}
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
                    <ListPlus className="h-3.5 w-3.5 text-primary" /> List:
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
                disabled={importDisabled}
                title={
                  parsedCount === 0
                    ? 'No valid emails detected — paste or upload emails first'
                    : listMode === 'existing' && !listId
                      ? 'Select a list first'
                      : needsListName && !newListName.trim()
                        ? 'Name this list'
                        : ''
                }
              >
                {importing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" /> Import{' '}
                    {parsedCount ? `${parsedCount} rows` : ''}
                  </>
                )}
              </Button>
            </div>

            <div className="mt-4 flex items-start gap-2 border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <div>
                Tip: Each import creates a <span className="font-medium">new list row</span> (not a
                column). Use it in Campaigns under{' '}
                <span className="font-medium">Recipients → Lists</span>. Click{' '}
                <span className="font-medium">Delete list</span> on any list header to remove a previous
                import.
              </div>
            </div>
            </div>
          </div>
        </div>
      )}

      {listModal
        ? createPortal(
        <div className="mailer-root fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close"
            onClick={() => setListModal(null)}
          />
          <div className="mailer-panel relative z-10 flex max-h-[90vh] w-full max-w-5xl flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--mailer-stroke)] px-5 py-4">
              <div className="min-w-0">
                <p className="mailer-hint" style={{ marginTop: 0 }}>
                  audience · list
                </p>
                <h2 className="truncate text-lg font-semibold text-primary">{listModal.name}</h2>
                <p className="page-sub">
                  {modalTotal.toLocaleString()} {modalTotal === 1 ? 'contact' : 'contacts'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setListModal(null)}
                className="border border-[var(--mailer-stroke)] p-2 text-[var(--mailer-dim)] hover:text-primary"
                aria-label="Close"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--mailer-stroke)] px-5 py-3">
              <Input
                className="min-w-[12rem] flex-1"
                placeholder="Search this list…"
                value={modalSearch}
                onChange={(e) => setModalSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setModalPage(1);
                    void loadListMembers(listModal.id, 1, modalSearch);
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setModalPage(1);
                  void loadListMembers(listModal.id, 1, modalSearch);
                }}
              >
                Search
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {modalLoading ? (
                <PageLoading label="Loading list…" />
              ) : (
                <table className="min-w-full">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Added</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {modalContacts.map((c) => (
                      <tr key={c.id}>
                        <td className="px-4 py-2 font-medium">{c.email}</td>
                        <td className="px-4 py-2 text-[var(--mailer-dim)]">
                          {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={c.status === 'SUBSCRIBED' ? 'success' : 'neutral'} className="capitalize">
                            {c.status.toLowerCase()}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-[var(--mailer-dim)]">
                          {new Date(c.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void deleteContact(c.id, c.email)}
                            className="text-[var(--mailer-dim)] hover:text-destructive"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!modalContacts.length ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-[var(--mailer-dim)]">
                          No contacts in this list
                          {modalSearch.trim() ? ' match the search' : ''}.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              )}
            </div>
            {modalTotal > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--mailer-stroke)] px-5 py-3 text-xs">
                <span className="text-[var(--mailer-dim)]">
                  Page {modalPage} of {modalPages} · {modalTotal.toLocaleString()} total
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={modalPage <= 1 || modalLoading}
                    onClick={() => {
                      const next = modalPage - 1;
                      setModalPage(next);
                      void loadListMembers(listModal.id, next, modalSearch);
                    }}
                  >
                    ‹ Prev
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={modalPage >= modalPages || modalLoading}
                    onClick={() => {
                      const next = modalPage + 1;
                      setModalPage(next);
                      void loadListMembers(listModal.id, next, modalSearch);
                    }}
                  >
                    Next ›
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>,
        document.body,
      )
        : null}
    </div>
  );
}
