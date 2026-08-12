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
  /safe link/i,
  /link scanner/i,
  /email scanner/i,
];

function isLegitimateMailProxy(ua: string): boolean {
  return LEGITIMATE_MAIL_PROXY.some((re) => re.test(ua));
}

function isScannerChrome(ua: string): boolean {
  const m = ua.match(/Chrome\/(\d+)/i);
  if (!m) return false;
  const version = parseInt(m[1], 10);
  // Bulk scanners often mimic ancient Chrome (e.g. Chrome/42 on Windows NT 10).
  return version < 70;
}

export type AutomatedTrackingReason =
  | 'esp_image_prefetch'
  | 'security_scanner'
  | 'bot_user_agent'
  | 'scanner_chrome';

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

  // Headless link sandboxes (common when mail lands in spam / security queues).
  if (/X11; Linux x86_64/i.test(ua) && /Chrome/i.test(ua)) {
    return { automated: true, reason: 'security_scanner' };
  }

  return { automated: false };
}

export function isHumanTrackingEvent(
  userAgent: string | null | undefined,
  metadata: unknown,
): boolean {
  if (metadata && typeof metadata === 'object' && (metadata as { source?: string }).source === 'automated') {
    return false;
  }
  return !classifyAutomatedTracking(userAgent).automated;
}

/** Prisma filter: excludes events already tagged as automated in metadata. */
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
