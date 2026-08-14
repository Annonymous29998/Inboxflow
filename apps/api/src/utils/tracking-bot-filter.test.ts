import { describe, expect, it } from 'vitest';
import { isCountableClick, isCountableOpen } from './tracking-bot-filter.js';

const GMAIL_PROXY =
  'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CURL = 'curl/8.4.0';

describe('isCountableOpen', () => {
  it('counts Gmail image proxy as a real open', () => {
    expect(isCountableOpen(GMAIL_PROXY, undefined)).toBe(true);
  });

  it('does not count curl or empty UA', () => {
    expect(isCountableOpen(CURL, undefined)).toBe(false);
    expect(isCountableOpen('', undefined)).toBe(false);
  });
});

describe('isCountableClick', () => {
  it('counts a Windows Chrome click', () => {
    expect(isCountableClick(WINDOWS_CHROME, undefined)).toBe(true);
  });

  it('drops scanner tools', () => {
    expect(isCountableClick(CURL, undefined)).toBe(false);
  });

  it('recounts older rows tagged automated as non_mail_client', () => {
    const stale = { source: 'automated', reason: 'non_mail_client' };
    expect(isCountableClick(WINDOWS_CHROME, stale)).toBe(true);
    expect(isCountableClick(WINDOWS_CHROME, { source: 'automated', reason: 'scanner_burst' })).toBe(true);
  });

  it('still rejects named scanners', () => {
    expect(isCountableClick(CURL, { source: 'automated', reason: 'bot_user_agent' })).toBe(false);
  });
});
