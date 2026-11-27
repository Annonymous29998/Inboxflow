import { useRef, useState } from 'react';
import {
  activeAttachments,
  appendAttachments,
  attachmentKind,
  formatAttachmentSize,
  type CampaignAttachment,
} from '@/lib/letter-placeholders';
import { toast } from '@/stores/toast';

export function AttachmentsPane({
  attachments,
  onAttachments,
}: {
  attachments: CampaignAttachment[];
  onAttachments: (next: CampaignAttachment[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const sending = activeAttachments(attachments);

  async function take(list: FileList | File[] | null) {
    const files = Array.from(list || []);
    if (!files.length) return;
    const { next, notes } = await appendAttachments(attachments, files);
    onAttachments(next);
    for (const note of notes) toast.warning(note);
    const added = next.length - attachments.length;
    if (added > 0) {
      toast.success(
        added === 1 ? 'File attached' : `${added} files attached`,
        'Ticked files are downloads on every email',
      );
    }
  }

  function patch(index: number, next: Partial<CampaignAttachment>) {
    onAttachments(attachments.map((file, i) => (i === index ? { ...file, ...next } : file)));
  }

  return (
    <div className="attach-pane">
      <p className="mailer-hint" style={{ marginTop: 0 }}>
        Add a file or an audio clip. Each ticked item is sent with every recipient as a real attachment, the kind a mailbox lists under the letter with a download.
      </p>
      <button
        type="button"
        className={over ? 'attach-drop over' : 'attach-drop'}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void take(event.dataTransfer.files);
        }}
      >
        Drop files here, or choose them
        <span>PDF, Word, Excel, ZIP, images, MP3, WAV, M4A, or any other file</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void take(event.target.files);
          event.target.value = '';
        }}
      />
      {attachments.length ? (
        <table className="attach-table">
          <thead>
            <tr>
              <th>Send</th>
              <th>File</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {attachments.map((file, index) => (
              <tr key={`${file.filename}-${index}`}>
                <td>
                  <input
                    type="checkbox"
                    checked={file.enabled !== false}
                    aria-label={`Send ${file.filename}`}
                    onChange={(event) => patch(index, { enabled: event.target.checked })}
                  />
                </td>
                <td>
                  <strong>{file.filename}</strong>
                  <div className="meta">{attachmentKind(file)}</div>
                </td>
                <td>{formatAttachmentSize(file.size)}</td>
                <td>
                  <button type="button" onClick={() => onAttachments(attachments.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mailer-hint">No files yet. A letter without a tick here sends the HTML only.</p>
      )}
      <p className="mailer-hint">
        {sending.length} of {attachments.length} on this send
        {sending.length
          ? ` · ${formatAttachmentSize(sending.reduce((sum, file) => sum + file.size, 0))}`
          : ''}
        . Untick a file to leave it off without deleting it.
      </p>
    </div>
  );
}
