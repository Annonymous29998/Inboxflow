import { describe, expect, it } from 'vitest';
import {
  isCountableClick,
  isCountableOpen,
  SCANNER_BURST_MS,
} from './tracking-bot-filter.js';

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
  it('counts a single Windows Chrome click as a person (unsubscribe / link)', () => {
    expect(isCountableClick(WINDOWS_CHROME, undefined, { burst: false })).toBe(true);
  });

  it('drops Safe Links double-fetch bursts', () => {
    expect(isCountableClick(WINDOWS_CHROME, undefined, { burst: true })).toBe(false);
  });

  it('drops scanner tools', () => {
    expect(isCountableClick(CURL, undefined, { burst: false })).toBe(false);
  });

  it('scanner burst window is 15s', () => {
    expect(SCANNER_BURST_MS).toBe(15_000);
  });
});
