import { describe, expect, it } from 'vitest';
import { listUnsubscribeHeaders } from './mail-headers.js';
import { isMailboxProviderTrackingOrigin } from './public-url.js';
import { parseUrlEncodedBody } from '../../utils/form-body.js';

describe('mailbox provider link shape', () => {
  it('accepts https on a domain at port 443', () => {
    expect(isMailboxProviderTrackingOrigin('https://track.example.com')).toBe(true);
    expect(isMailboxProviderTrackingOrigin('https://track.example.com:443/api/t')).toBe(true);
  });

  it('rejects raw IP, extra ports, and plain http', () => {
    expect(isMailboxProviderTrackingOrigin('http://52.188.193.112:5000')).toBe(false);
    expect(isMailboxProviderTrackingOrigin('https://52.188.193.112')).toBe(false);
    expect(isMailboxProviderTrackingOrigin('https://track.example.com:5000')).toBe(false);
    expect(isMailboxProviderTrackingOrigin('http://track.example.com')).toBe(false);
  });
});

describe('list unsubscribe headers', () => {
  it('advertises one-click only on https', () => {
    expect(listUnsubscribeHeaders('https://track.example.com/api/t/unsubscribe?c=1')).toEqual({
      'List-Unsubscribe': '<https://track.example.com/api/t/unsubscribe?c=1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(listUnsubscribeHeaders('http://52.188.193.112:5000/api/t/unsubscribe?c=1')).toEqual({
      'List-Unsubscribe': '<http://52.188.193.112:5000/api/t/unsubscribe?c=1>',
    });
  });
});

describe('one-click form body', () => {
  it('reads the Gmail and Microsoft POST body', () => {
    expect(parseUrlEncodedBody('List-Unsubscribe=One-Click')).toEqual({
      'List-Unsubscribe': 'One-Click',
    });
  });
});
