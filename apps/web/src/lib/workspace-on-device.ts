import { useToastStore } from '@/stores/toast';

export const WORKSPACE_ON_DEVICE_COPY =
  'Campaigns, contacts, and SMTP stay on this PC. Open the Inbox Flow Windows app to continue.';

export function isWorkspaceOnDeviceError(err: unknown) {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: string }).code || '') : '';
  if (code === 'WORKSPACE_ON_DEVICE') return true;
  const msg = err instanceof Error ? err.message : String((err as { message?: string }).message || '');
  return /Open Inbox Flow on this PC/i.test(msg);
}

export function reportWorkspaceOnDevice(err?: unknown) {
  if (err !== undefined && !isWorkspaceOnDeviceError(err)) return false;
  useToastStore.getState().push({
    title: WORKSPACE_ON_DEVICE_COPY,
    tone: 'warning',
    durationMs: 12_000,
  });
  return true;
}
