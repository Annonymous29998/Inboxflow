/**
 * Gmail / Outlook / Comcast etc. signal "slow down" with 4xx SMTP codes.
 * Treat those as a pause + retry, not a bounce, so the sending IP is not blocked.
 */

const THROTTLE_RE =
  /\b421\b|\b450\b|\b451\b|\b452\b|4\.7\.[0-2]|4\.2\.1|4\.3\.2|rate[\s-]?limit|too many (connections|recipients|messages|sessions|logins)|try again later|temporarily (deferred|rejected|unavailable)|please try later|greylist|throttl|congestion|resources temporarily|slow down|deferred due to/i;

const MAX_THROTTLE_ATTEMPTS = 8;

export function isSmtpThrottleError(raw: string | undefined): boolean {
  const msg = String(raw || '').trim();
  if (!msg) return false;
  if (/\b55[0-4]\b|5\.7\.|5\.1\./.test(msg) && !/\b421\b|\b450\b|\b451\b/.test(msg)) {
    return false;
  }
  return THROTTLE_RE.test(msg);
}

export function throttleRetryMs(raw: string | undefined, attempt = 1): number {
  const msg = String(raw || '');
  const minMatch = msg.match(/retry after (\d+)\s*min/i);
  if (minMatch) return Math.min(15 * 60_000, Number(minMatch[1]) * 60_000);
  const secMatch = msg.match(/retry after (\d+)\s*sec/i);
  if (secMatch) return Math.min(15 * 60_000, Number(secMatch[1]) * 1000);
  return Math.min(10 * 60_000, 60_000 * Math.max(1, attempt));
}

export function throttleAttemptsLeft(attempt: number): boolean {
  return attempt <= MAX_THROTTLE_ATTEMPTS;
}

/** Consecutive 535/554 (account/auth/policy block) — pause instead of burning the list. */
export const SMTP_BLOCK_STREAK_LIMIT = 10;

const ACCOUNT_BLOCK_RE =
  /\b535\b|\b554\b|eauth|invalid login|authentication failed|auth(?:entication)? (?:failed|rejected|not enabled)|account (?:disabled|suspended|blocked|inactive)|relay (?:access )?denied|policy rejection|5\.7\.[01]\b/i;

export function isSmtpAccountBlockError(raw: string | undefined): boolean {
  const msg = String(raw || '').trim();
  if (!msg) return false;
  return ACCOUNT_BLOCK_RE.test(msg);
}

export { MAX_THROTTLE_ATTEMPTS };
