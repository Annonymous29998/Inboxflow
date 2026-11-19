import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyHs256AccessToken } from './hybrid-jwt.js';

function mint(secret: string, payload: object) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

describe('hybrid JWT', () => {
  const secret = 'dev-access-secret-change-me-32chars!!';

  it('accepts a signed access token', () => {
    const token = mint(secret, {
      sub: 'user-1',
      email: 'a@example.com',
      role: 'USER',
      organizationId: 'org-1',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const payload = verifyHs256AccessToken(token, secret);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.role).toBe('USER');
  });

  it('rejects a payload with no signature', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'evil', role: 'SUPER_ADMIN' })).toString('base64url');
    expect(verifyHs256AccessToken(`${header}.${body}.`, secret)).toBeNull();
    expect(verifyHs256AccessToken(`${header}.${body}`, secret)).toBeNull();
  });
});
