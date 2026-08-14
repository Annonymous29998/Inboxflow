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
 * Count an open when a mail client loads the pixel, or a Mac/phone browser.
 * A click still counts as opened in the recipient table.
 */
export function isCountableOpen(
  userAgent: string | null | undefined,
  metadata: unknown,
): boolean {
  if (metadata && typeof metadata === 'object' && (metadata as { source?: string }).source === 'automated') {
    const reason = (metadata as { reason?: string }).reason;
    if (reason && !['no_verified_open', 'non_mail_client', 'scanner_burst'].includes(reason)) {
      return false;
    }
  }
  const ua = (userAgent || '').trim();
  if (!ua || classifyAutomatedTracking(ua).automated) return false;
  if (isLegitimateMailProxy(ua)) return true;
  if (isMobileMailClient(ua)) return true;
  if (/Macintosh|Mac OS X/i.test(ua)) return true;
  if (isDesktopBotBrowser(ua)) return false;
  return false;
}

/**
 * Count a click from a real browser (Chrome/Safari/Firefox/Edge), including Windows.
 * Named bots (curl, Proofpoint) stay out. Double-clicks still show as 2×.
 */
export function isCountableClick(
  userAgent: string | null | undefined,
  metadata: unknown,
  _contactHasVerifiedOpen?: boolean,
): boolean {
  if (metadata && typeof metadata === 'object') {
    const m = metadata as { source?: string; reason?: string };
    if (
      m.source === 'automated' &&
      m.reason &&
      !['no_verified_open', 'non_mail_client', 'scanner_burst'].includes(m.reason)
    ) {
      return false;
    }
  }
  const ua = (userAgent || '').trim();
  if (!ua || classifyAutomatedTracking(ua).automated) return false;
  if (isScannerChrome(ua)) return false;
  if (isLegitimateMailProxy(ua)) return true;
  if (isMobileMailClient(ua)) return true;
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

export function filterCountableClicks<T extends ClickLike>(
  clicks: T[],
  _verifiedOpenContactIds?: Set<string>,
): T[] {
  return clicks.filter((e) => isCountableClick(e.userAgent, e.metadata));
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
