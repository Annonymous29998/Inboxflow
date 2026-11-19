export type SmtpRecipientKind = 'sent' | 'hard_bounce' | 'soft_bounce' | 'failed' | 'throttled';

/** Classify the SMTP conversation for this one recipient (Blue Sender-style). */
export function classifySmtpRecipientResult(raw: string): SmtpRecipientKind {
  const msg = String(raw || '').trim();
  if (!msg) return 'failed';

  if (/421|450|451|452.*try|greylist|throttl|rate.?limit|too many|try again later/i.test(msg)) {
    return 'throttled';
  }
  if (
    /mailbox full|over quota|quota exceeded|452\s*4\.2\.2|552\s*5\.2\.2|user is overquota|insufficient storage/i.test(
      msg,
    )
  ) {
    return 'soft_bounce';
  }
  if (
    /5\.1\.1|5\.1\.2|user unknown|unknown user|does not exist|no such user|mailbox unavailable|550\s*5\.1|recipient rejected|invalid recipient|undeliverable/i.test(
      msg,
    )
  ) {
    return 'hard_bounce';
  }
  if (/5\.\d\.\d|550|553|554|permanent/i.test(msg)) {
    return 'failed';
  }
  return 'failed';
}

export function smtpRecipientStatus(kind: SmtpRecipientKind): 'FAILED' | 'BOUNCED' {
  return kind === 'hard_bounce' || kind === 'soft_bounce' ? 'BOUNCED' : 'FAILED';
}
