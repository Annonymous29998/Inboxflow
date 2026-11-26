import { describe, expect, it } from 'vitest';
import { cloudAuthorizationFor, rememberCloudAuthorization } from './desktop-cloud-auth.js';

describe('desktop cloud authorization', () => {
  it('keeps a bearer token for the signed-in organization', () => {
    rememberCloudAuthorization('org-1', 'Bearer session-token');
    expect(cloudAuthorizationFor('org-1')).toBe('Bearer session-token');
    expect(cloudAuthorizationFor('org-2')).toBeNull();
  });

  it('ignores an empty header', () => {
    rememberCloudAuthorization('org-3', '');
    expect(cloudAuthorizationFor('org-3')).toBeNull();
  });
});
