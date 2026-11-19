import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PlaceholderPane } from '@/components/campaigns/LetterMergePanel';
import {
  previewLetterHtml,
  previewMergeVars,
  type CampaignAttachment,
} from '@/lib/letter-placeholders';
import { promptDialog } from '@/stores/confirm';

type LetterMode = 'source' | 'preview' | 'editor' | 'placeholder';

const FONT_FACES = ['Arial', 'Georgia', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Courier New'];
const FONT_SIZES = [
  { v: '1', l: '8' },
  { v: '2', l: '10' },
  { v: '3', l: '12' },
  { v: '4', l: '14' },
  { v: '5', l: '18' },
  { v: '6', l: '24' },
  { v: '7', l: '36' },
];

function serializeDoc(doc: Document) {
  const html = doc.documentElement?.outerHTML || '';
  if (/<!DOCTYPE/i.test(html)) return html;
  return `<!DOCTYPE html>\n${html}`;
}

export function LetterPane({
  html,
  onHtmlChange,
  onImportFile,
  onImportClick,
  importing,
  actions,
  placeholderMap = {},
  spinPools = {},
  onPlaceholderMap,
  attachments = [],
  onAttachments,
  previewContacts = [],
  senderName,
  physicalAddress,
  showPlaceholderTab = false,
}: {
  html: string;
  onHtmlChange: (next: string) => void;
  onImportFile?: (file: File) => Promise<void> | void;
  onImportClick?: () => void;
  importing?: boolean;
  actions?: ReactNode;
  placeholderMap?: Record<string, string>;
  spinPools?: Record<string, string[]>;
  onPlaceholderMap?: (next: Record<string, string>) => void;
  attachments?: CampaignAttachment[];
  onAttachments?: (next: CampaignAttachment[]) => void;
  previewContacts?: Array<{ email: string; firstName?: string | null; lastName?: string | null }>;
  senderName?: string | null;
  physicalAddress?: string | null;
  /** Templates overlay only — campaign uses the workspace Placeholder tab. */
  showPlaceholderTab?: boolean;
}) {
  const [mode, setMode] = useState<LetterMode>('editor');
  const [source, setSource] = useState(html);
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const skipReload = useRef(false);
  const savedRange = useRef<Range | null>(null);
  const bindAbort = useRef<AbortController | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [previewEmail, setPreviewEmail] = useState('');
  const [editMarks, setEditMarks] = useState<Record<string, boolean>>({});

  const previewPerson = previewContacts.find((c) => c.email === previewEmail) || previewContacts[0];
  const displayHtml =
    mode === 'preview'
      ? previewLetterHtml(
          html,
          previewMergeVars({
            email: previewPerson?.email || 'alex@example.com',
            firstName: previewPerson?.firstName || 'Alex',
            lastName: previewPerson?.lastName || '',
            senderName,
            physicalAddress,
          }),
          placeholderMap,
          previewPerson?.email || 'alex@example.com',
          spinPools,
        )
      : html;

  useEffect(() => {
    setSource(html);
    const iframe = iframeRef.current;
    if (!iframe || mode === 'source' || mode === 'placeholder') return;
    const fallback =
      displayHtml ||
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#444">Start typing your email…</body></html>';
    if (mode === 'preview') {
      iframe.srcdoc = fallback;
      return;
    }
    if (skipReload.current) {
      skipReload.current = false;
      return;
    }
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    const typing =
      Boolean(win) &&
      doc?.designMode === 'on' &&
      (document.activeElement === iframe || Boolean(doc.hasFocus?.()));
    if (typing) return;
    iframe.srcdoc = fallback;
  }, [html, displayHtml, mode]);

  function editorDoc() {
    return iframeRef.current?.contentDocument || null;
  }

  function rememberRange(doc: Document) {
    const sel = doc.getSelection();
    if (sel && sel.rangeCount) {
      try {
        savedRange.current = sel.getRangeAt(0).cloneRange();
      } catch {
        /* ignore */
      }
    }
  }

  function restoreRange(doc: Document) {
    const range = savedRange.current;
    const sel = doc.getSelection();
    if (!sel) return false;
    try {
      sel.removeAllRanges();
      if (range && doc.contains(range.startContainer)) {
        sel.addRange(range);
        return true;
      }
    } catch {
      /* stale range after reload */
    }
    const body = doc.body;
    if (!body) return false;
    const end = doc.createRange();
    end.selectNodeContents(body);
    end.collapse(false);
    sel.addRange(end);
    savedRange.current = end.cloneRange();
    return true;
  }

  function flushEditor() {
    const doc = editorDoc();
    if (!doc) return;
    const next = serializeDoc(doc);
    skipReload.current = true;
    setSource(next);
    onHtmlChange(next);
  }

  function readMarks(doc: Document) {
    const tags = new Set<string>();
    const sel = doc.getSelection();
    let node: Node | null = sel?.anchorNode || null;
    while (node && node !== doc.body && node !== doc.documentElement) {
      if (node.nodeType === 1) tags.add((node as Element).tagName);
      node = node.parentNode;
    }
    const next: Record<string, boolean> = {
      bold: tags.has('B') || tags.has('STRONG'),
      italic: tags.has('I') || tags.has('EM'),
      underline: tags.has('U'),
      strikeThrough: tags.has('S') || tags.has('STRIKE') || tags.has('DEL'),
    };
    for (const cmd of ['insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']) {
      try {
        next[cmd] = doc.queryCommandState(cmd);
      } catch {
        next[cmd] = false;
      }
    }
    setEditMarks(next);
  }

  function withEditor(fn: (doc: Document) => void) {
    const iframe = iframeRef.current;
    const doc = editorDoc();
    if (!iframe || !doc) return;
    iframe.contentWindow?.focus();
    restoreRange(doc);
    try {
      doc.execCommand('styleWithCSS', false, 'false');
    } catch {
      /* ignore */
    }
    fn(doc);
    rememberRange(doc);
    flushEditor();
    readMarks(doc);
  }

  function runEdit(command: string, value?: string) {
    withEditor((doc) => {
      try {
        doc.execCommand(command, false, value);
        if (command === 'hiliteColor' && !doc.queryCommandValue('hiliteColor')) {
          doc.execCommand('backColor', false, value);
        }
      } catch {
        if (command === 'hiliteColor') {
          try {
            doc.execCommand('backColor', false, value);
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  function insertHtmlChunk(markup: string) {
    withEditor((doc) => {
      try {
        const ok = doc.execCommand('insertHTML', false, markup);
        if (ok !== false) return;
      } catch {
        /* fall through */
      }
      const sel = doc.getSelection();
      if (!sel) return;
      if (!sel.rangeCount) restoreRange(doc);
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const wrap = doc.createElement('div');
      wrap.innerHTML = markup;
      const frag = doc.createDocumentFragment();
      while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      range.insertNode(frag);
    });
  }

  async function insertLink() {
    const doc = editorDoc();
    if (doc) rememberRange(doc);
    const href = await promptDialog('Insert link', {
      placeholder: 'https://',
      defaultValue: 'https://',
      confirmText: 'Insert',
      validate: (v) => (v.trim() ? null : 'Enter a URL'),
    });
    if (!href?.trim()) return;
    const url = href.trim();
    withEditor((editor) => {
      const sel = editor.getSelection();
      const collapsed = !sel || sel.isCollapsed || !String(sel).trim();
      if (collapsed) {
        const label = url.replace(/^https?:\/\//i, '');
        const chunk = `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`;
        try {
          if (!editor.execCommand('insertHTML', false, chunk)) throw new Error('insertHTML');
        } catch {
          const range = sel?.rangeCount ? sel.getRangeAt(0) : savedRange.current;
          if (!range) return;
          const a = editor.createElement('a');
          a.href = url;
          a.textContent = label;
          range.insertNode(a);
        }
      } else {
        editor.execCommand('createLink', false, url);
      }
    });
  }

  function insertLocalFile(file: File | undefined) {
    if (!file) return;
    const doc = editorDoc();
    if (doc) rememberRange(doc);
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      if (!url) return;
      if (file.type.startsWith('image/')) runEdit('insertImage', url);
      else {
        const name = file.name.replace(/[<>]/g, '');
        insertHtmlChunk(`<a href="${url}">${name}</a>`);
      }
    };
    reader.readAsDataURL(file);
  }

  function insertTable() {
    insertHtmlChunk(
      '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%"><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></table>',
    );
  }

  function bindFrame() {
    bindAbort.current?.abort();
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc) return;
    const editable = modeRef.current === 'editor';
    try {
      doc.designMode = editable ? 'on' : 'off';
      if (doc.body) doc.body.contentEditable = editable ? 'true' : 'false';
      if (editable) {
        doc.execCommand('defaultParagraphSeparator', false, 'p');
        doc.execCommand('styleWithCSS', false, 'false');
      }
    } catch {
      /* ignore */
    }
    if (!editable) return;
    const ac = new AbortController();
    bindAbort.current = ac;
    const { signal } = ac;
    const onInput = () => {
      rememberRange(doc);
      flushEditor();
      readMarks(doc);
    };
    doc.addEventListener('input', onInput, { signal });
    doc.addEventListener('mouseup', () => {
      rememberRange(doc);
      readMarks(doc);
    }, { signal });
    doc.addEventListener('keyup', () => {
      rememberRange(doc);
      readMarks(doc);
    }, { signal });
    doc.addEventListener('selectionchange', () => {
      rememberRange(doc);
      readMarks(doc);
    }, { signal });
    doc.addEventListener('blur', onInput, { capture: true, signal });
  }

  function applySource() {
    onHtmlChange(source);
    skipReload.current = false;
  }

  async function copySource() {
    try {
      await navigator.clipboard.writeText(source || html);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  const modes: Array<[LetterMode, string]> = [
    ['editor', 'Editor'],
    ['preview', 'Preview'],
    ['source', 'HTML'],
  ];
  if (showPlaceholderTab && onPlaceholderMap && onAttachments) {
    modes.push(['placeholder', 'Placeholder']);
  }

  return (
    <div className="letter-stage">
      <div className="letter-bar">
        <div>
          {modes.map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (mode === 'source' && id !== 'source') applySource();
                if (mode === 'editor' && id !== 'editor') {
                  const doc = iframeRef.current?.contentDocument;
                  if (doc) {
                    const next = serializeDoc(doc);
                    setSource(next);
                    onHtmlChange(next);
                  }
                }
                setMode(id);
              }}
              className={cn(mode === id && 'on')}
            >
              {name}
            </button>
          ))}
        </div>
        <div>
          {mode === 'preview' && previewContacts.length ? (
            <select
              className="letter-bar-select"
              value={previewEmail}
              onChange={(e) => setPreviewEmail(e.target.value)}
              aria-label="Preview as contact"
            >
              <option value="">{previewContacts[0] ? 'First in list' : 'Sample Alex'}</option>
              {previewContacts.map((c) => (
                <option key={c.email} value={c.email}>
                  {[c.firstName, c.lastName].filter(Boolean).join(' ') || c.email}
                </option>
              ))}
            </select>
          ) : null}
          {actions}
          {onImportClick ? (
            <button type="button" className={cn(importing && 'busy')} disabled={importing} onClick={onImportClick}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          ) : onImportFile ? (
            <label className={cn('letter-file', importing && 'busy')}>
              {importing ? 'Importing…' : 'Import'}
              <input
                type="file"
                accept=".html,.htm,.mjml,.txt,text/html"
                disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void onImportFile(file);
                }}
              />
            </label>
          ) : null}
          <button type="button" onClick={() => void copySource()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([source || html || ''], { type: 'text/html;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'letter.html';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export
          </button>
        </div>
      </div>
      {mode === 'editor' ? (
        <div
          className="letter-editbar"
          onMouseDown={(e) => {
            const doc = editorDoc();
            if (doc) rememberRange(doc);
            if ((e.target as HTMLElement).closest('button')) e.preventDefault();
          }}
        >
          <button type="button" title="Undo" onClick={() => runEdit('undo')}>
            ↩
          </button>
          <button type="button" title="Redo" onClick={() => runEdit('redo')}>
            ↪
          </button>
          <span className="letter-editbar-sep" />
          <select className="letter-editbar-select" title="Font" defaultValue="Arial" onChange={(e) => runEdit('fontName', e.target.value)} onMouseDown={() => { const doc = editorDoc(); if (doc) rememberRange(doc); }}>
            {FONT_FACES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select className="letter-editbar-select slim" title="Size" defaultValue="3" onChange={(e) => runEdit('fontSize', e.target.value)} onMouseDown={() => { const doc = editorDoc(); if (doc) rememberRange(doc); }}>
            {FONT_SIZES.map((s) => (
              <option key={s.v} value={s.v}>
                {s.l}
              </option>
            ))}
          </select>
          <span className="letter-editbar-sep" />
          <button type="button" title="Bold" className={cn(editMarks.bold && 'on')} onClick={() => runEdit('bold')}>
            B
          </button>
          <button type="button" title="Italic" className={cn('em', editMarks.italic && 'on')} onClick={() => runEdit('italic')}>
            I
          </button>
          <button type="button" title="Underline" className={cn('ul', editMarks.underline && 'on')} onClick={() => runEdit('underline')}>
            U
          </button>
          <button type="button" title="Strikethrough" className={cn(editMarks.strikeThrough && 'on')} onClick={() => runEdit('strikeThrough')}>
            S
          </button>
          <label className="letter-editbar-color" title="Text color">
            A
            <input type="color" defaultValue="#111111" onChange={(e) => runEdit('foreColor', e.target.value)} />
          </label>
          <label className="letter-editbar-color fill" title="Highlight">
            ▮
            <input type="color" defaultValue="#fff59d" onChange={(e) => runEdit('hiliteColor', e.target.value)} />
          </label>
          <span className="letter-editbar-sep" />
          <button type="button" title="Bullets" className={cn(editMarks.insertUnorderedList && 'on')} onClick={() => runEdit('insertUnorderedList')}>
            •
          </button>
          <button type="button" title="Numbered list" className={cn(editMarks.insertOrderedList && 'on')} onClick={() => runEdit('insertOrderedList')}>
            1.
          </button>
          <button type="button" title="Align left" className={cn(editMarks.justifyLeft && 'on')} onClick={() => runEdit('justifyLeft')}>
            ≡
          </button>
          <button type="button" title="Align center" className={cn(editMarks.justifyCenter && 'on')} onClick={() => runEdit('justifyCenter')}>
            ≣
          </button>
          <button type="button" title="Align right" className={cn(editMarks.justifyRight && 'on')} onClick={() => runEdit('justifyRight')}>
            ≢
          </button>
          <button type="button" title="Indent" onClick={() => runEdit('indent')}>
            »
          </button>
          <button type="button" title="Outdent" onClick={() => runEdit('outdent')}>
            «
          </button>
          <span className="letter-editbar-sep" />
          <button type="button" title="Insert link" onClick={() => void insertLink()}>
            Link
          </button>
          <button type="button" title="Remove link" onClick={() => runEdit('unlink')}>
            Unlink
          </button>
          <button type="button" title="Insert image or file" onClick={() => fileRef.current?.click()}>
            File
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/*,.pdf,.txt,.html,.htm,.zip"
            onChange={(e) => {
              insertLocalFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button type="button" title="Insert table" onClick={() => void insertTable()}>
            Table
          </button>
          <button type="button" title="Horizontal line" onClick={() => runEdit('insertHorizontalRule')}>
            HR
          </button>
          <button type="button" title="Clear formatting" onClick={() => runEdit('removeFormat')}>
            Clear
          </button>
        </div>
      ) : null}
      {mode === 'placeholder' && onPlaceholderMap && onAttachments ? (
        <PlaceholderPane
          html={html}
          onHtmlChange={onHtmlChange}
          placeholderMap={placeholderMap}
          onPlaceholderMap={onPlaceholderMap}
          spinPools={spinPools}
          attachments={attachments}
          onAttachments={onAttachments}
        />
      ) : mode === 'source' ? (
        <textarea
          ref={sourceRef}
          value={source}
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value;
            setSource(next);
            onHtmlChange(next);
          }}
          className="letter-source"
        />
      ) : (
        <iframe
          ref={iframeRef}
          title={mode === 'editor' ? 'letter-editor' : 'letter-preview'}
          sandbox="allow-same-origin"
          onLoad={bindFrame}
          className="letter-frame"
        />
      )}
    </div>
  );
}
