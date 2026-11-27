import { describe, expect, it } from 'vitest';
import { buildMailboxAttachments } from './mailbox-attachments.js';

describe('buildMailboxAttachments', () => {
  it('sends any file type as a download and skips unticked files', () => {
    const files = buildMailboxAttachments([
      { filename: 'offer.pdf', contentType: 'application/pdf', contentBase64: 'UERG', enabled: true },
      { filename: 'photo.png', contentType: 'image/png', contentBase64: 'UE5H', enabled: true },
      { filename: 'sheet.xlsx', contentType: '', contentBase64: 'WExT', enabled: true },
      { filename: 'notes.zip', contentType: 'application/zip', contentBase64: 'WklQ', enabled: false },
      { filename: 'skip.txt', contentBase64: '' },
    ]);
    expect(files.map((file) => file.filename)).toEqual(['offer.pdf', 'photo.png', 'sheet.xlsx']);
    expect(files.every((file) => file.contentDisposition === 'attachment')).toBe(true);
    expect(files[2]?.contentType).toBe('application/octet-stream');
  });

  it('sends audio as an audio download even when the browser left the type blank', () => {
    const files = buildMailboxAttachments([
      { filename: 'voice.mp3', contentType: '', contentBase64: 'TVAz' },
      { filename: 'note.wav', contentBase64: 'V0FW' },
      { filename: 'clip.m4a', contentType: 'application/octet-stream', contentBase64: 'TTRB' },
      { filename: 'song.mp3', contentType: 'audio/mp3', contentBase64: 'TVAz' },
    ]);
    expect(files.map((file) => file.contentType)).toEqual(['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/mpeg']);
    expect(files.every((file) => file.contentDisposition === 'attachment')).toBe(true);
    expect(files[0]?.encoding).toBe('base64');
    expect(files[0]?.content).toBe('TVAz');
  });

  it('keeps at most ten files', () => {
    const raw = Array.from({ length: 12 }, (_, index) => ({
      filename: `file-${index}.bin`,
      contentBase64: 'QQ==',
    }));
    expect(buildMailboxAttachments(raw)).toHaveLength(10);
  });
});
