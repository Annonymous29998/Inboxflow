import { Prisma } from '@prisma/client';

const LEGITIMATE_MAIL_PROXY = [
  /googleimageproxy/i,
  /google.*image.*proxy/i,
  /yahoo.*mail/i,
  /outlook/i,
  /microsoft office/i,
  /msoffice/i,
  /thunderbird/i,
  /apple mail/i,
  /iphone.*mail/i,
  /ipad.*mail/i,
];

const AUTOMATED_UA = [
  /brevo\/1\.0/i,
  /redirection-images/i,
  /sendinblue/i,
  /proofpoint/i,
  /mimecast/i,
  /barracuda/i,
  /spamassassin/i,
  /cloudmark/i,
  /symantec/i,
  /trend micro/i,
  /forcepoint/i,
  /fireeye/i,
  /ironport/i,
  /messagelabs/i,
  /python-requests/i,
  /curl\//i,
  /wget\//i,
  /go-http-client/i,
  /headlesschrome/i,
  /phantomjs/i,
  /selenium/i,
  /urlscan/i,
  /phishtank/i,
  /safe.?link/i,
  /safelinks/i,
  /link scanner/i,
  /email scanner/i,
  /skypeuripreview/i,
  /microsoft office existence/i,
  /defender/i,
  /bingpreview/i,
  /slackbot/i,
  /facebookexternalhit/i,
];

function isLegitimateMailProxy(ua: string): boolean {
  return LEGITIMATE_MAIL_PROXY.some((re) => re.test(ua));
}

function isMobileMailClient(ua: string): boolean {
  return (
    (/\b(iPhone|iPad)\b/i.test(ua) && /AppleWebKit/i.test(ua)) ||
    (/Android/i.test(ua) && /Mobile/i.test(ua))
  );
}

function isScannerChrome(ua: string): boolean {
  const m = ua.match(/Chrome\/(\d+)/i);
  if (!m) return false;
  const version = parseInt(m[1], 10);
  return version < 70;
}

/** Desktop Windows/Linux browsers are overwhelmingly spam-filter bots on bulk sends. */
function isDesktopBotBrowser(ua: string): boolean {
  return /Windows NT|X11; Linux/i.test(ua);
}

export type AutomatedTrackingReason =
  | 'esp_image_prefetch'
  | 'security_scanner'
  | 'bot_user_agent'
  | 'scanner_chrome'
  | 'no_verified_open'
  | 'non_mail_client'
  | 'scanner_burst';

/** Two hits this close are Microsoft Safe Links / ATP, not a person clicking twice. */
export const SCANNER_BURST_MS = 15_000;

export function classifyAutomatedTracking(userAgent: string | undefined | null): {
  automated: boolean;
  reason?: AutomatedTrackingReason;
} {
  const ua = (userAgent || '').trim();
  if (!ua) {
    return { automated: true, reason: 'bot_user_agent' };
  }

  if (isLegitimateMailProxy(ua)) {
    return { automated: false };
  }

  if (/brevo|redirection-images|sendinblue/i.test(ua)) {
    return { automated: true, reason: 'esp_image_prefetch' };
  }

  if (AUTOMATED_UA.some((re) => re.test(ua))) {
    return { automated: true, reason: 'security_scanner' };
  }

  if (isScannerChrome(ua)) {
    return { automated: true, reason: 'scanner_chrome' };
  }

  if (/X11; Linux x86_64/i.test(ua) && /Chrome/i.test(ua)) {
    return { automated: true, reason: 'security_scanner' };
  }

  return { automated: false };
}

/**
 * Count an open only when the request looks like a real mail client loading images
 * (Gmail/Outlook/Yahoo proxy, Apple/Android mobile mail) — not a spam sandbox.
 */
export function isCountableOpen(
  userAgent: string | null | undefined,
  metadata: unknown,
): boolean {
  if (metadata && typeof metadata === 'object' && (metadata as { source?: string }).source === 'automated') {
    return false;
  }
  const ua = (userAgent || '').trim();
  if (!ua || classifyAutomatedTracking(ua).automated) return false;
  if (isLegitimateMailProxy(ua)) return true;
  if (isMobileMailClient(ua)) return true;
  // Reject generic desktop browsers (spam filters mimic Chrome on Windows/Linux).
  if (isDesktopBotBrowser(ua)) return false;
  return false;
}

export type CountableClickOpts = {
  /** True when this contact already loaded a real mail-client open pixel. */
  hasVerifiedOpen?: boolean;
  /** True when another click from the same contact landed within SCANNER_BURST_MS. */
  burst?: boolean;
};

/**
 * Count a real click. Scanners (Safe Links, ATP) look like Chrome on Windows and
 * hit every link twice in a few seconds — those must not count as people.
 *
 * Windows/Linux Chrome is only trusted if this contact already had a mail-client open
 * (Gmail/Outlook/Yahoo proxy or mobile mail). Mac / phone browsers can count without that.
 */
export function isCountableClick(
  userAgent: string | null | undefined,
  metadata: unknown,
  contactHasVerifiedOpenOrOpts?: boolean | CountableClickOpts,
): boolean {
  const opts: CountableClickOpts =
    typeof contactHasVerifiedOpenOrOpts === 'object' && contactHasVerifiedOpenOrOpts
      ? contactHasVerifiedOpenOrOpts
      : { hasVerifiedOpen: Boolean(contactHasVerifiedOpenOrOpts) };

  if (opts.burst) return false;

  if (metadata && typeof metadata === 'object') {
    const m = metadata as { source?: string };
    if (m.source === 'automated') return false;
  }
  const ua = (userAgent || '').trim();
  if (!ua || classifyAutomatedTracking(ua).automated) return false;
  if (isScannerChrome(ua)) return false;
  if (isLegitimateMailProxy(ua)) return true;
  if (isMobileMailClient(ua)) return true;
  if (/Macintosh|Mac OS X/i.test(ua) && /Safari\/|Chrome\/|Firefox\/|Edg\//i.test(ua)) {
    return true;
  }
  // Safe Links / ATP almost always spoof Chrome on Windows or Linux.
  if (isDesktopBotBrowser(ua)) {
    return Boolean(opts.hasVerifiedOpen);
  }
  if (/Chrome\/|CriOS\/|Firefox\/|FxiOS\/|Edg\/|EdgiOS\/|Safari\//i.test(ua)) {
    return true;
  }
  return false;
}

type ClickLike = {
  contactId: string | null;
  createdAt: Date;
  userAgent: string | null;
  metadata: unknown;
};

/** Drop Safe Links double-fetches and untrusted Windows Chrome clicks. */
export function filterCountableClicks<T extends ClickLike>(
  clicks: T[],
  verifiedOpenContactIds: Set<string>,
): T[] {
  const timesByContact = new Map<string, number[]>();
  for (const e of clicks) {
    if (!e.contactId) continue;
    const arr = timesByContact.get(e.contactId) ?? [];
    arr.push(e.createdAt.getTime());
    timesByContact.set(e.contactId, arr);
  }

  return clicks.filter((e) => {
    if (!e.contactId) return false;
    const times = timesByContact.get(e.contactId) ?? [];
    const t = e.createdAt.getTime();
    const burst = times.some((other) => {
      const d = Math.abs(other - t);
      return d > 0 && d <= SCANNER_BURST_MS;
    });
    return isCountableClick(e.userAgent, e.metadata, {
      hasVerifiedOpen: verifiedOpenContactIds.has(e.contactId),
      burst,
    });
  });
}

/** @deprecated use isCountableOpen */
export function isHumanTrackingEvent(
  userAgent: string | null | undefined,
  metadata: unknown,
): boolean {
  return isCountableOpen(userAgent, metadata);
}

export function humanTrackingEventFilter(): Prisma.TrackingEventWhereInput {
  return {
    OR: [
      { metadata: { equals: Prisma.DbNull } },
      {
        NOT: {
          metadata: {
            path: ['source'],
            equals: 'automated',
          },
        },
      },
    ],
  };
}
