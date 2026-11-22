import { Link } from 'react-router-dom';
import { bindPcHref, bindPcIsExternal, isInboxflowDesktop } from '@/lib/bind-pc';

export function BindRequiredModal({
  open,
  username,
  onDismiss,
}: {
  open: boolean;
  username?: string;
  onDismiss?: () => void;
}) {
  if (!open) return null;
  const desktop = isInboxflowDesktop();
  const href = bindPcHref(username);
  const linkClass =
    'inline-flex w-full items-center justify-center border border-primary bg-primary px-3 py-2 text-sm font-bold uppercase tracking-wide text-primary-foreground';

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/75 p-4">
      <div className="tui-box w-full max-w-md">
        <div className="tui-box-title">PC not bound</div>
        <div className="space-y-4 p-4">
          <p className="text-xs text-muted-foreground">
            <span className="tui-tag tui-tag-err">[ WARN ]</span> This PC is not bound yet.
          </p>
          {desktop ? (
            <p className="text-sm text-foreground">
              Use the Bind PC link your admin sent you. Complete Bind PC in the browser on that link first, then open
              this app again.
            </p>
          ) : (
            <>
              <p className="text-sm text-foreground">
                Open Bind PC, sign in with your username and license key, then bind this PC.
              </p>
              {bindPcIsExternal(href) ? (
                <a className={linkClass} href={href}>
                  Bind PC
                </a>
              ) : (
                <Link className={linkClass} to={href}>
                  Bind PC
                </Link>
              )}
            </>
          )}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="w-full border border-border px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              Stay on sign in
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
