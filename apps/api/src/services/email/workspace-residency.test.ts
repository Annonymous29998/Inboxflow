import { describe, expect, it } from 'vitest';
import {
  isDeviceWorkspacePath,
  isPlatformOperator,
  orgKeepsWorkspaceOnDevice,
} from './workspace-residency.js';

describe('workspace residency', () => {
  it('treats admin logins as operators', () => {
    expect(isPlatformOperator({ role: 'SUPER_ADMIN' })).toBe(true);
    expect(isPlatformOperator({ role: 'ADMIN' })).toBe(true);
    expect(isPlatformOperator({ email: 'admin@inboxflow.com' })).toBe(true);
    expect(isPlatformOperator({ role: 'USER', email: 'client@shop.com' })).toBe(false);
  });

  it('keeps platform admin on the shared database', () => {
    expect(
      orgKeepsWorkspaceOnDevice({
        role: 'SUPER_ADMIN',
        email: 'anyone@x.com',
        sendSettings: { smtpAllowDirect: false, workspaceLocal: true },
      }),
    ).toBe(false);
    expect(orgKeepsWorkspaceOnDevice({ email: 'admin@inboxflow.com' })).toBe(false);
  });

  it('keeps admin-created users on-device', () => {
    expect(
      orgKeepsWorkspaceOnDevice({
        role: 'USER',
        email: 'client@shop.com',
        sendSettings: { smtpAllowDirect: false },
      }),
    ).toBe(true);
    expect(
      orgKeepsWorkspaceOnDevice({
        role: 'USER',
        email: 'client@shop.com',
        sendSettings: { workspaceLocal: true },
      }),
    ).toBe(true);
  });

  it('does not force legacy users off the server', () => {
    expect(
      orgKeepsWorkspaceOnDevice({
        role: 'USER',
        email: 'legacy@user.com',
      }),
    ).toBe(false);
  });

  it('matches workspace API paths', () => {
    expect(isDeviceWorkspacePath('/api/contacts?page=1')).toBe(true);
    expect(isDeviceWorkspacePath('/api/campaigns/abc/send-one')).toBe(true);
    expect(isDeviceWorkspacePath('/api/admin/organization')).toBe(true);
    expect(isDeviceWorkspacePath('/api/auth/me')).toBe(false);
    expect(isDeviceWorkspacePath('/api/admin/users')).toBe(false);
    expect(isDeviceWorkspacePath('/api/workspace/pulse')).toBe(false);
  });
});
