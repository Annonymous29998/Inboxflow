/** User-facing send line. Raw SMTP text, including a 250 id, stays off the log. */

export function recipientLogDetail(status: string, raw?: string | null): string | null {
  const text = String(raw || '').trim();
  if (status === 'OPENED') return 'opened';
  if (status === 'CLICKED') return 'clicked';
  if (status === 'SENT' || status === 'DELIVERED') {
    if (text && !isSmtpAccept(text)) return text;
    return 'sent successfully';
  }
  if (status !== 'FAILED' && status !== 'BOUNCED') return text || null;
  if (/mailbox full|over quota|quota exceeded|4\.2\.2|5\.2\.2|insufficient storage/i.test(text)) {
    return 'mailbox full';
  }
  if (
    /5\.1\.1|5\.1\.2|user unknown|unknown user|does not exist|no such user|mailbox unavailable|recipient rejected|invalid recipient|undeliverable/i.test(
      text,
    )
  ) {
    return 'recipient does not exist';
  }
  return 'mail not accepted';
}

function isSmtpAccept(text: string): boolean {
  return /^250\b/.test(text) || /requested mail action okay/i.test(text) || /^2\.\d\.\d\b/.test(text);
}
