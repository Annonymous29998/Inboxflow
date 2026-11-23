import { describe, expect, it } from 'vitest';
import { ensureHtmlDocument, repairHtmlLinks, shapeOutboundLetter } from './outbound-shape.js';

describe('outbound letter shape', () => {
  it('wraps a fragment in a complete html document', () => {
    const html = ensureHtmlDocument('<p>Hello</p>');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<body><p>Hello</p></body>');
  });

  it('repairs www and protocol-relative links and drops empty hrefs', () => {
    const html = repairHtmlLinks(
      '<a href="www.example.com/a">A</a><a href="//cdn.example.com/b">B</a><a href="">C</a><a href="alert(1)">D</a>',
    );
    expect(html).toContain('href="https://www.example.com/a"');
    expect(html).toContain('href="https://cdn.example.com/b"');
    expect(html).not.toContain('href=""');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('>D</a>');
  });

  it('keeps a real https link and writes a plain-text part without tags', () => {
    const shaped = shapeOutboundLetter({
      subject: 'Hello\nthere',
      html: '<p>See <a href="https://example.com/path?a=1&amp;b=2">this</a></p>',
      text: '<p>broken</p>',
    });
    expect(shaped.subject).toBe('Hello there');
    expect(shaped.html).toContain('href="https://example.com/path?a=1&amp;b=2"');
    expect(shaped.text).not.toContain('<p>');
    expect(shaped.text).toContain('broken');
  });
});
