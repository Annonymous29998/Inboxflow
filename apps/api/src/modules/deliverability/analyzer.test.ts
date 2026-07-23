import { describe, it, expect } from 'vitest';
import { analyzeCampaign, analyzeSubjectLine } from './analyzer.js';

describe('Deliverability Analyzer', () => {
  it('scores a well-formed campaign highly', () => {
    const report = analyzeCampaign({
      subject: 'Your weekly product tips, {{firstName}}',
      previewText: 'Three practical ideas to improve your workflow this week.',
      htmlContent: `<!DOCTYPE html><html><body>
        <h1>Hello {{firstName}}</h1>
        <p>Here are some tips for your week. We hope they help.</p>
        <img src="https://cdn.example.com/a.jpg" alt="Product screenshot" />
        <a href="https://example.com/tips">Read the tips</a>
        <p>123 Market St, San Francisco, CA</p>
        <a href="https://example.com/unsubscribe">Unsubscribe</a>
      </body></html>`,
      plainTextContent: 'Hello {{firstName}}. Tips for your week. Unsubscribe: https://example.com/unsubscribe',
      physicalAddress: '123 Market St, San Francisco, CA',
      authStatus: { spf: true, dkim: true, dmarc: true },
    });

    expect(report.score).toBeGreaterThanOrEqual(70);
    expect(report.rating).not.toBe('high_risk');
  });

  it('flags spam phrases and missing unsubscribe', () => {
    const report = analyzeCampaign({
      subject: 'ACT NOW!!! FREE MONEY',
      htmlContent: '<p>BUY NOW and make money guaranteed!!!</p>',
      authStatus: { spf: false, dkim: false, dmarc: false },
    });

    expect(report.score).toBeLessThan(50);
    expect(report.rating).toBe('high_risk');
    expect(report.issues.some((i) => i.id === 'missing-unsubscribe')).toBe(true);
    expect(report.issues.some((i) => i.category === 'authentication')).toBe(true);
  });

  it('analyzes subject lines', () => {
    const analysis = analyzeSubjectLine('URGENT!!! BUY NOW');
    expect(analysis.score).toBeLessThan(70);
    expect(analysis.alternatives.length).toBeGreaterThan(0);
  });
});
