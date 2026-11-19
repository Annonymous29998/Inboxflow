import { describe, expect, it } from 'vitest';
import { normalizeClickDest, wrapCampaignLinks } from './wrap-campaign-links.js';

describe('wrapCampaignLinks', () => {
  const opts = { origin: 'http://vps.example:5000', campaignId: 'camp1', contactId: 'ct1' };

  it('wraps CTA buttons and plain anchors', () => {
    const html = `
      <a href="https://inboxflow.io" style="display:inline-block">Browse catalog</a>
      <a href='http://shop.example/x'>text</a>
    `;
    const { html: out } = wrapCampaignLinks(html, '', opts);
    expect(out).toContain('/api/t/c/camp1/ct1?t=');
    expect(out).not.toContain('https://inboxflow.io');
    expect(out).not.toMatch(/href=["']https:\/\/inboxflow\.io["']/);
  });

  it('skips unsubscribe and already-wrapped links', () => {
    const html = `<a href="http://vps.example:5000/api/t/unsubscribe?c=1">Unsub</a>
      <a href="http://vps.example:5000/api/t/c/camp1/ct1?u=https%3A%2F%2Fx.com&s=ab">x</a>`;
    const { html: out } = wrapCampaignLinks(html, '', opts);
    expect(out).toContain('/api/t/unsubscribe');
    expect(out.match(/\/api\/t\/c\//g)?.length).toBe(1);
  });

  it('skips mailto and javascript', () => {
    const html = `<a href="mailto:a@b.com">m</a><a href="javascript:alert(1)">j</a>`;
    const { html: out } = wrapCampaignLinks(html, '', opts);
    expect(out).toContain('mailto:a@b.com');
    expect(out).toContain('javascript:alert(1)');
    expect(out).not.toContain('/api/t/c/');
  });

  it('wraps www and protocol-relative and text URLs', () => {
    expect(normalizeClickDest('www.shop.com/a')).toBe('https://www.shop.com/a');
    expect(normalizeClickDest('//cdn.example/x')).toBe('https://cdn.example/x');
    const { text } = wrapCampaignLinks('', 'See https://inboxflow.io/sale now', opts);
    expect(text).toContain('/api/t/c/camp1/ct1?t=');
  });
});
