import { describe, expect, it } from 'vitest';
import { firstNameFromEmail, personalize } from './personalize.js';

describe('firstNameFromEmail', () => {
  it('uses clean local-part as first name', () => {
    expect(firstNameFromEmail('john@gmail.com')).toBe('John');
    expect(firstNameFromEmail('mary.smith@company.com')).toBe('Mary');
  });

  it('skips local-parts that contain digits', () => {
    expect(firstNameFromEmail('ronniech78@gmail.com')).toBe('');
    expect(firstNameFromEmail('ronniechristopher89@gmail.com')).toBe('');
    expect(firstNameFromEmail('john99@x.com')).toBe('');
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

  it('falls back from email only when no digits', () => {
    expect(
      personalize('Hi {{firstName}},', { firstName: null, email: 'sam@gmail.com' }),
    ).toBe('Hi Sam,');
    expect(
      personalize('Hi {{firstName}},', { firstName: null, email: 'sam42@gmail.com' }),
    ).toBe('Hi ,');
  });
});
