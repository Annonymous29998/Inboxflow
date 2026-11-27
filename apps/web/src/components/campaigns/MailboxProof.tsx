import { useState } from 'react';
import { detectPlaceholders, suggestCanonical, customDataRecord, type PreviewContact, type CampaignAttachment } from '@/lib/letter-placeholders';

const SAMPLE: PreviewContact = {
  email: 'alex@example.com',
  firstName: 'Alex',
  lastName: 'Rivera',
  customData: { company: 'Northwind' },
};

export function MailboxProof({
  html,
  contacts,
  index,
  onIndex,
  subject,
  senderName,
  senderEmail,
  attachments,
  onContactChange,
  proofAddress,
  onProofAddress,
  onSendCopy,
}: {
  html: string;
  contacts: PreviewContact[];
  index: number;
  onIndex: (next: number) => void;
  subject: string;
  senderName?: string | null;
  senderEmail?: string | null;
  attachments: CampaignAttachment[];
  onContactChange: (next: PreviewContact) => void;
  proofAddress: string;
  onProofAddress: (next: string) => void;
  onSendCopy?: (input: { to: string }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const usingSample = contacts.length === 0;
  const person = contacts[index] || SAMPLE;
  const total = Math.max(contacts.length, 1);
  const position = contacts.length ? index + 1 : 1;
  const custom = customDataRecord(person.customData);
  const fieldKeys = [
    ...new Set([
      ...detectPlaceholders(html)
        .filter((item) => item.kind !== 'spin')
        .map((item) => item.tag)
        .filter((tag) => tag && !suggestCanonical(tag)),
      ...Object.keys(custom),
    ]),
  ].slice(0, 8);

  const named = [person.firstName, person.lastName].filter(Boolean).join(' ');
  const who = named || person.email;
  const fromLine = [senderName?.trim(), senderEmail?.trim() ? `<${senderEmail.trim()}>` : '']
    .filter(Boolean)
    .join(' ');

  function patch(next: PreviewContact) {
    onContactChange(next);
  }

  async function sendCopy() {
    if (!onSendCopy) return;
    setBusy(true);
    try {
      await onSendCopy({ to: proofAddress.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mailbox-proof">
      <div className="mailbox-proof-nav">
        <button type="button" disabled={usingSample} onClick={() => onIndex(index - 1)} aria-label="Previous recipient">
          ‹
        </button>
        <span>
          {usingSample ? 'Sample' : `${position} of ${total}`}
          <em>{who}</em>
        </span>
        <button type="button" disabled={usingSample} onClick={() => onIndex(index + 1)} aria-label="Next recipient">
          ›
        </button>
      </div>
      <dl>
        <div>
          <dt>From</dt>
          <dd>{fromLine || 'Sender name on Setup'}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>{named ? `${named} <${person.email}>` : person.email}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>{subject.trim() || 'Add a subject on Setup'}</dd>
        </div>
        {attachments.length ? (
          <div>
            <dt>Files</dt>
            <dd className="mailbox-files">
              {attachments.map((file) => (
                <span key={file.filename}>{file.filename}</span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="mailbox-fields">
        <label>
          <span>First</span>
          <input
            value={person.firstName || ''}
            onChange={(e) => patch({ ...person, firstName: e.target.value })}
          />
        </label>
        <label>
          <span>Last</span>
          <input
            value={person.lastName || ''}
            onChange={(e) => patch({ ...person, lastName: e.target.value })}
          />
        </label>
        {fieldKeys.map((key) => (
          <label key={key}>
            <span>{key}</span>
            <input
              value={custom[key] || ''}
              onChange={(e) =>
                patch({
                  ...person,
                  customData: { ...custom, [key]: e.target.value },
                })
              }
            />
          </label>
        ))}
        <p>
          {usingSample
            ? 'Import a recipient list to step through real people. This sample shows how the letter fills.'
            : 'These values belong to this person. The letter below uses them. A saved contact keeps the edit.'}
        </p>
      </div>
      {onSendCopy ? (
        <form
          className="mailbox-send"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCopy();
          }}
        >
          <label>
            Send this copy to
            <input
              type="email"
              value={proofAddress}
              placeholder="you@gmail.com"
              onChange={(e) => onProofAddress(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send this copy'}
          </button>
        </form>
      ) : null}
    </div>
  );
}
