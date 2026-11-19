import { describe, expect, it } from 'vitest';
import { applyLinkRedirectMap } from './apply-link-redirects.js';

describe('applyLinkRedirectMap', () => {
  it('swaps CTA hrefs for the user redirect', () => {
    const html = `<a href="https://shop.example/sale" style="display:inline-block">Buy</a>`;
    const out = applyLinkRedirectMap(html, {
      'https://shop.example/sale': 'https://go.mydomain.com/r/sale',
    });
    expect(out).toContain('https://go.mydomain.com/r/sale');
    expect(out).not.toContain('https://shop.example/sale');
  });

  it('leaves unmapped and unsafe targets', () => {
    const html = `<a href="https://shop.example/a">A</a><a href="https://shop.example/b">B</a>`;
    const out = applyLinkRedirectMap(html, {
      'https://shop.example/a': 'javascript:alert(1)',
    });
    expect(out).toContain('https://shop.example/a');
    expect(out).toContain('https://shop.example/b');
  });
});
