import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button, Input, Select, Textarea } from '@/components/ui';
import {
  ATTACH_MAX_BYTES,
  ATTACH_MAX_FILES,
  CANONICAL_FIELDS,
  detectPlaceholders,
  removePlaceholderToken,
  suggestCanonical,
  type CampaignAttachment,
} from '@/lib/letter-placeholders';
import { detectLetterLinks, isHttpUrl, replaceLetterHref } from '@/lib/letter-links';
import { toast } from '@/stores/toast';
import { cn } from '@/lib/utils';

type Draft = { mode: 'field' | 'spin'; field: string; lines: string };

function defaultDraft(kind: 'mustache' | 'brace' | 'spin', tag: string, parts?: string[]): Draft {
  const field = suggestCanonical(tag) || tag;
  if (kind === 'spin') {
    return { mode: 'spin', field, lines: (parts || []).join('\n') };
  }
  return { mode: 'field', field, lines: '' };
}

function LetterLinkRow({
  href,
  html,
  onHtmlChange,
}: {
  href: string;
  html: string;
  onHtmlChange: (next: string) => void;
}) {
  const [value, setValue] = useState(href);
  useEffect(() => {
    setValue(href);
  }, [href]);

  function commit() {
    const next = value.trim();
    if (!next || next === href) return;
    if (!isHttpUrl(next)) return;
    onHtmlChange(replaceLetterHref(html, href, next));
  }

  return (
    <div className="ph-link">
      <div className="ph-link-row">
        <Input
          className="ph-add"
          value={value}
          aria-label="Letter link"
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button
          type="button"
          className="ph-token"
          disabled={!isHttpUrl(value)}
          onClick={() => {
            if (!isHttpUrl(value)) return;
            window.open(value, '_blank', 'noopener,noreferrer');
          }}
        >
          Open
        </button>
      </div>
      {value.trim() && !isHttpUrl(value.trim()) ? (
        <p className="mailer-hint" style={{ margin: 0 }}>
          Use a normal https:// URL
        </p>
      ) : null}
    </div>
  );
}

export function PlaceholderPane({
  html,
  onHtmlChange,
  placeholderMap,
  onPlaceholderMap,
  spinPools = {},
  onSpinPools,
  attachments,
  onAttachments,
}: {
  html: string;
  onHtmlChange: (next: string) => void;
  placeholderMap: Record<string, string>;
  onPlaceholderMap: (next: Record<string, string>) => void;
  spinPools?: Record<string, string[]>;
  onSpinPools?: (next: Record<string, string[]>) => void;
  attachments: CampaignAttachment[];
  onAttachments: (next: CampaignAttachment[]) => void;
}) {
  const detected = useMemo(() => detectPlaceholders(html), [html]);
  const scannedLinks = useMemo(() => detectLetterLinks(html), [html]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [customTag, setCustomTag] = useState('');
  const [focusToken, setFocusToken] = useState('');

  const detectedKey = detected.map((d) => d.token).join('\n');
  useEffect(() => {
    const tokens = new Set(detected.map((d) => d.token));
    setDrafts((prev) => {
      const next: Record<string, Draft> = {};
      for (const d of detected) {
        const pooled = spinPools[d.tag];
        if (pooled?.length) {
          next[d.token] = {
            mode: 'spin',
            field: suggestCanonical(d.tag) || d.tag,
            lines: pooled.join('\n'),
          };
          continue;
        }
        next[d.token] =
          prev[d.token] && tokens.has(d.token)
            ? prev[d.token]!
            : defaultDraft(d.kind, d.tag, d.kind === 'spin' ? d.parts : undefined);
      }
      return next;
    });
    // Rebuild when the clicked letter’s tags change, not on every spin keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedKey]);

  function setDraft(token: string, patch: Partial<Draft>) {
    const row = detected.find((d) => d.token === token);
    setDrafts((prev) => {
      const merged = { ...(prev[token] || defaultDraft('mustache', token)), ...patch };
      if (row) {
        if (onSpinPools) {
          const nextPools = { ...spinPools };
          if (merged.mode === 'spin') {
            nextPools[row.tag] = merged.lines
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
          } else {
            delete nextPools[row.tag];
          }
          onSpinPools(nextPools);
        }
        if (merged.mode === 'field') {
          const field = (merged.field || row.tag).trim();
          if (field && placeholderMap[row.tag] !== field) {
            onPlaceholderMap({ ...placeholderMap, [row.tag]: field });
          }
        }
      }
      return { ...prev, [token]: merged };
    });
  }

  function insertToken(token: string) {
    const next = token.trim();
    if (!next) return;
    if (/<\/body>/i.test(html)) onHtmlChange(html.replace(/<\/body>/i, `${next}</body>`));
    else onHtmlChange(`${html}${next}`);
    toast.success('Added to letter', next);
  }

  function normalizeTypedTag(raw: string) {
    const t = raw.trim();
    if (!t) return '';
    if (/^\{\{/.test(t) || /^\{/.test(t) || /^\[\[/.test(t) || /^\*\|/.test(t)) return t;
    return `{{${t}}}`;
  }

  function insertTypedTag() {
    const token = normalizeTypedTag(customTag);
    if (!token) return;
    insertToken(token);
    setCustomTag('');
  }

  function deleteTag(token: string, tag: string) {
    const next = removePlaceholderToken(html, token);
    if (next === html) return;
    onHtmlChange(next);
    if (placeholderMap[tag]) {
      const map = { ...placeholderMap };
      delete map[tag];
      onPlaceholderMap(map);
    }
    if (onSpinPools && spinPools[tag]) {
      const pools = { ...spinPools };
      delete pools[tag];
      onSpinPools(pools);
    }
    if (focusToken === token) setFocusToken('');
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (next.length >= ATTACH_MAX_FILES) break;
      if (file.size > ATTACH_MAX_BYTES) continue;
      const buf = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      next.push({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64: btoa(binary),
        size: file.size,
      });
    }
    onAttachments(next);
  }

  return (
    <div className="ph-pane">
      <p className="mailer-hint" style={{ marginTop: 0 }}>
        Tags found in this letter. Type any tag — {'{{firstName}}'}, {'{{company}}'}, {'{{city}}'}. A column with that name on the lead file fills it.
      </p>

      <div className="ph-row" style={{ marginTop: 0 }}>
        <span className="ph-k">Detected</span>
        {detected.length ? (
          detected.map((d) => (
            <button
              key={d.token}
              type="button"
              className="ph-token"
              title="Show this tag’s card"
              onClick={() => {
                setFocusToken(d.token);
                document.getElementById(`ph-card-${encodeURIComponent(d.token)}`)?.scrollIntoView({ block: 'nearest' });
              }}
            >
              {d.token}
            </button>
          ))
        ) : (
          <span className="mailer-hint" style={{ margin: 0 }}>
            None yet
          </span>
        )}
      </div>

      <div className="ph-row">
        <span className="ph-k">Add tag</span>
        <Input
          className="ph-add"
          value={customTag}
          placeholder="{{city}} or {Hi|Hello}"
          aria-label="Insert any placeholder"
          onChange={(e) => setCustomTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              insertTypedTag();
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={insertTypedTag} disabled={!customTag.trim()}>
          Insert
        </Button>
      </div>

      {!detected.length ? (
        <p className="mailer-hint">
          Import a letter that already has tags, or insert one here. Cards appear as soon as a tag is in the HTML.
        </p>
      ) : (
        <div className="ph-grid">
          {detected.map((d) => {
            const draft = drafts[d.token] || defaultDraft(d.kind, d.tag, d.kind === 'spin' ? d.parts : undefined);
            return (
              <div
                key={d.token}
                id={`ph-card-${encodeURIComponent(d.token)}`}
                className={cn('ph-card', focusToken === d.token && 'on')}
              >
                <div className="ph-card-head">
                  <code className="ph-card-tag">{d.token}</code>
                  <button
                    type="button"
                    className="ph-card-del"
                    title={`Delete ${d.token} from letter`}
                    aria-label={`Delete ${d.token}`}
                    onClick={() => deleteTag(d.token, d.tag)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </div>
                <Select
                  value={draft.mode}
                  onChange={(e) => setDraft(d.token, { mode: e.target.value as 'field' | 'spin' })}
                  aria-label={`How to fill ${d.token}`}
                >
                  <option value="field">Recipient field</option>
                  <option value="spin">Spin (one per line)</option>
                </Select>
                {draft.mode === 'spin' ? (
                  <>
                    <Textarea
                      className="ph-card-lines font-mono text-xs"
                      value={draft.lines}
                      onChange={(e) => setDraft(d.token, { lines: e.target.value })}
                      placeholder={'Hi\nHello\nHey'}
                    />
                    <p className="mailer-hint" style={{ margin: 0 }}>
                      One per line · rotates on send
                    </p>
                  </>
                ) : (
                  <Select
                    value={CANONICAL_FIELDS.some((f) => f.key === draft.field) ? draft.field : draft.field}
                    onChange={(e) => setDraft(d.token, { field: e.target.value })}
                  >
                    {CANONICAL_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label} · {`{{${f.key}}}`}
                      </option>
                    ))}
                    {!CANONICAL_FIELDS.some((f) => f.key === d.tag) ? (
                      <option value={d.tag}>Keep {d.token}</option>
                    ) : null}
                  </Select>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="ph-head">Links</div>
      <p className="mailer-hint" style={{ marginTop: 0 }}>
        Detected CTAs and links. Edit the URL yourself — recipients open that address directly, with no extra hop page.
      </p>
      {!scannedLinks.length ? (
        <p className="mailer-hint">No http(s) links in this letter yet.</p>
      ) : (
        <div className="ph-links">
          {scannedLinks.map((href) => (
            <LetterLinkRow key={href} href={href} html={html} onHtmlChange={onHtmlChange} />
          ))}
        </div>
      )}

      <div className="ph-row">
        <span className="ph-k">Attach</span>
        <label className="letter-file">
          Files
          <input
            type="file"
            multiple
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {attachments.map((a, i) => (
          <button
            key={`${a.filename}-${i}`}
            type="button"
            className="ph-token"
            title="Remove attachment"
            onClick={() => onAttachments(attachments.filter((_, idx) => idx !== i))}
          >
            {a.filename} ×
          </button>
        ))}
      </div>
    </div>
  );
}
