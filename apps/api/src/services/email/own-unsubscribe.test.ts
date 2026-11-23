import { describe, expect, it } from 'vitest';
import { ensureOwnUnsubscribe, listUnsubscribeHeaders } from './mail-headers.js';

const own = 'https://novasreach.xyz/api/t/unsubscribe?o=org&c=person&cid=camp&s=sig';

describe('own unsubscribe link', () => {
  it('adds Inbox Flow’s link when the letter already has a different unsubscribe URL', () => {
    const letter = '<html><body><p>Hello</p><a href="https://shop.example/unsub">Unsubscribe</a></body></html>';
    const out = ensureOwnUnsubscribe(letter, 'Hello\nUnsubscribe: https://shop.example/unsub', own);
    expect(out.html).toContain('https://shop.example/unsub');
    expect(out.html).toContain(`href="${own}"`);
    expect(out.html).toContain('Unsubscribe from these emails');
    expect(out.text).toContain('https://shop.example/unsub');
    expect(out.text).toContain(own);
    expect(out.html.match(/Unsubscribe from these emails/g)).toHaveLength(1);
  });

  it('does not add a second copy when the letter already uses this URL', () => {
    const letter = `<html><body><a href="${own}">Unsubscribe</a></body></html>`;
    const out = ensureOwnUnsubscribe(letter, `Unsubscribe: ${own}`, own);
    expect(out.html.match(new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(out.text.match(new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('keeps one https one-click header for that same URL', () => {
    expect(listUnsubscribeHeaders(own)).toEqual({
      'List-Unsubscribe': `<${own}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});
