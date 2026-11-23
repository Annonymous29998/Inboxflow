import { describe, expect, it } from 'vitest';
import { unsubscribeConfirmHref, unsubscribeDonePage, unsubscribeLandingPage } from './unsubscribe-page.js';

describe('unsubscribe page', () => {
  it('shows the underlined choice before removing anyone', () => {
    const href = unsubscribeConfirmHref('/api/t/unsubscribe', {
      o: 'org',
      c: 'contact',
      cid: 'camp',
      s: 'sig',
    });
    const html = unsubscribeLandingPage(href);
    expect(html).toContain('You are about to stop receiving mail from this sender.');
    expect(html).toContain('>unsubscribe from this</a>');
    expect(html).toContain('confirm=1');
    expect(html).toContain('contact');
    expect(html).not.toContain('You have been unsubscribed');
  });

  it('confirms only after the link is used', () => {
    expect(unsubscribeDonePage()).toContain('You have been unsubscribed');
    expect(unsubscribeDonePage()).toContain('You will no longer receive these emails.');
  });
});
