export const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);

/**
 * Mailchimp / Klaviyo / SendGrid style:
 *   sent      = SMTP accepted
 *   delivered = sent − bounces
 *   open rate = unique opens ÷ delivered
 *   click rate (CTR) = unique clicks ÷ delivered
 *   CTOR      = unique clicks ÷ unique opens (secondary)
 */
export function standardEmailRates(input: {
  sent: number;
  bounced: number;
  opened: number;
  clicked: number;
  complained?: number;
}) {
  const sent = Math.max(0, Math.floor(Number(input.sent) || 0));
  const bounced = Math.min(sent, Math.max(0, Math.floor(Number(input.bounced) || 0)));
  const delivered = Math.max(0, sent - bounced);
  const opened = Math.max(0, Number(input.opened) || 0);
  const clicked = Math.max(0, Number(input.clicked) || 0);
  return {
    sent,
    delivered,
    bounced,
    deliveryRate: rate(delivered, sent),
    bounceRate: rate(bounced, sent),
    openRate: rate(opened, delivered),
    clickRate: rate(clicked, delivered),
    clickToOpenRate: rate(clicked, opened),
    spamComplaintRate: rate(input.complained ?? 0, sent),
  };
}

/** @deprecated use standardEmailRates — kept for older tests */
export function dashboardEngagementRates(input: {
  opened: number;
  clicked: number;
  delivered: number;
  sent: number;
}) {
  const ofDelivered = input.delivered || input.sent;
  return {
    openRate: rate(input.opened, ofDelivered),
    clickRate: rate(input.clicked, ofDelivered),
  };
}
