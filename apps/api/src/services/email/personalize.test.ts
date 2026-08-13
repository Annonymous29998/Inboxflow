import { describe, expect, it } from 'vitest';
import { applySenderName, firstNameFromEmail, personalize } from './personalize.js';

describe('firstNameFromEmail', () => {
  it('uses clean local-part as first name', () => {
    expect(firstNameFromEmail('john@gmail.com')).toBe('John');
    expect(firstNameFromEmail('mary.smith@company.com')).toBe('Mary');
  });

  it('strips digits and keeps letter name', () => {
    expect(firstNameFromEmail('ronniech78@gmail.com')).toBe('Ronniech');
    expect(firstNameFromEmail('ronniechristopher89@gmail.com')).toBe('Ronniechristopher');
    expect(firstNameFromEmail('john99@x.com')).toBe('John');
    expect(firstNameFromEmail('12345@x.com')).toBe('');
  });
});

describe('personalize firstName fallback', () => {
  it('prefers saved first name', () => {
    const out = personalize('Hi {{firstName}},', {
      firstName: 'Ada',
      email: 'ada99@gmail.com',
    });
    expect(out).toBe('Hi Ada,');
  });

  it('falls back from email and strips digits', () => {
    expect(
      personalize('Hi {{firstName}},', { firstName: null, email: 'sam@gmail.com' }),
    ).toBe('Hi Sam,');
    expect(
      personalize('Hi {{firstName}},', { firstName: null, email: 'sam42@gmail.com' }),
    ).toBe('Hi Sam,');
    expect(
      personalize('Hi {{firstName}},', { firstName: null, email: 'ronniech78@gmail.com' }),
    ).toBe('Hi Ronniech,');
  });
});

describe('personalize sender_name', () => {
  it('fills {{sender_name}} and {{senderName}} from vars', () => {
    const contact = { firstName: null, email: 'a@b.com' };
    expect(
      personalize('© 2026 {{sender_name}}. All rights reserved.', contact, {
        senderName: 'Inbox Flow',
      }),
    ).toBe('© 2026 Inbox Flow. All rights reserved.');
    expect(
      personalize('From {{senderName}}', contact, { senderName: 'Acme' }),
    ).toBe('From Acme');
  });

  it('preserves {{sender_name}} until applySenderName when vars omitted', () => {
    const raw = personalize('© {{sender_name}}', { email: 'a@b.com' });
    expect(raw).toBe('© {{sender_name}}');
    expect(applySenderName(raw, 'Brand Co')).toBe('© Brand Co');
  });
});
