/** Files and audio that ride with every recipient as real mailbox downloads. */

export const MAILBOX_ATTACH_MAX_FILES = 10;

const AUDIO_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  opus: 'audio/opus',
  weba: 'audio/webm',
  mid: 'audio/midi',
  midi: 'audio/midi',
  amr: 'audio/amr',
  caf: 'audio/x-caf',
};

/** Browsers often leave audio with a blank type. The mailbox still needs audio/mpeg, audio/wav, and the rest. */
export function mailboxContentType(filename: string, given?: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fromName = AUDIO_BY_EXT[ext];
  const raw = (given || '').split(';')[0].trim().toLowerCase();
  if (raw === 'audio/mp3' || raw === 'audio/x-mpeg' || raw === 'audio/mpeg3') return 'audio/mpeg';
  if (fromName) return fromName;
  if (raw.startsWith('audio/')) return raw;
  if (raw && raw !== 'application/octet-stream') return raw;
  return 'application/octet-stream';
}

export type StoredAttachment = {
  filename?: string;
  contentType?: string;
  contentBase64?: string;
  enabled?: boolean;
};

export function buildMailboxAttachments(raw: StoredAttachment[] | null | undefined) {
  return (raw || [])
    .filter((file) => file?.filename && file.contentBase64 && file.enabled !== false)
    .slice(0, MAILBOX_ATTACH_MAX_FILES)
    .map((file) => ({
      filename: String(file.filename).slice(0, 180),
      contentType: mailboxContentType(String(file.filename), file.contentType),
      content: String(file.contentBase64),
      encoding: 'base64' as const,
      contentDisposition: 'attachment' as const,
    }));
}
