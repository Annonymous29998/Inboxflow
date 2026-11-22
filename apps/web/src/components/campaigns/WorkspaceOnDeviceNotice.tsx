import { WORKSPACE_ON_DEVICE_COPY } from '@/lib/workspace-on-device';

export function WorkspaceOnDeviceNotice({ className }: { className?: string }) {
  return (
    <div
      className={className}
      role="status"
      style={{
        border: '1px solid var(--mailer-stroke, #333)',
        padding: '1rem 1.25rem',
        background: 'rgba(245, 158, 11, 0.12)',
      }}
    >
      <p className="text-sm font-medium text-amber-100">{WORKSPACE_ON_DEVICE_COPY}</p>
      <p className="mt-1 text-xs text-ink-muted">
        Bind PC in the browser is done. Sending and lists only work in the desktop app.
      </p>
    </div>
  );
}
