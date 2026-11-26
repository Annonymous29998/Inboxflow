import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accessTokenExpiry,
  cloudAuthorizationFor,
  cloudRefreshTokenFor,
  rememberCloudAuthorization,
} from './desktop-cloud-auth.js';

function token(exp: number) {
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `Bearer h.${body}.s`;
}

describe('desktop cloud authorization', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cloud-session-'));
  const previous = process.env.DESKTOP_CLOUD_SESSION_FILE;

  afterEach(() => {
    if (previous == null) delete process.env.DESKTOP_CLOUD_SESSION_FILE;
    else process.env.DESKTOP_CLOUD_SESSION_FILE = previous;
  });

  it('keeps a bearer token for the signed-in organization', () => {
    process.env.DESKTOP_CLOUD_SESSION_FILE = path.join(dir, 'a.json');
    rememberCloudAuthorization('org-1', 'Bearer session-token');
    expect(cloudAuthorizationFor('org-1')).toBe('Bearer session-token');
    expect(cloudAuthorizationFor('org-2')).toBeNull();
  });

  it('ignores an empty header', () => {
    process.env.DESKTOP_CLOUD_SESSION_FILE = path.join(dir, 'b.json');
    rememberCloudAuthorization('org-3', '');
    expect(cloudAuthorizationFor('org-3')).toBeNull();
  });

  it('keeps the longer-lived sign-in and stores the refresh token', () => {
    process.env.DESKTOP_CLOUD_SESSION_FILE = path.join(dir, 'c.json');
    const later = token(Math.floor(Date.now() / 1000) + 3600);
    const earlier = token(Math.floor(Date.now() / 1000) + 60);
    rememberCloudAuthorization('org-4', later, 'refresh-new');
    rememberCloudAuthorization('org-4', earlier, 'refresh-old');
    expect(cloudAuthorizationFor('org-4')).toBe(later);
    expect(accessTokenExpiry(later)).toBeGreaterThan(accessTokenExpiry(earlier));
    expect(cloudRefreshTokenFor('org-4')).toBe('refresh-new');
  });
});
