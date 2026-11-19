import { Link } from 'react-router-dom';
import { bindPcHref, bindPcIsExternal } from '@/lib/bind-pc';

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
  const href = bindPcHref();
  const withUser =
    username?.trim() && !bindPcIsExternal(href)
      ? `${href}${href.includes('?') ? '&' : '?'}user=${encodeURIComponent(username.trim())}`
      : href;
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
          <p className="text-sm text-foreground">
            Open Bind PC, sign in with your username and license key, then bind this PC.
          </p>
          {bindPcIsExternal(withUser) ? (
            <a className={linkClass} href={withUser}>
              Bind PC
            </a>
          ) : (
            <Link className={linkClass} to={withUser}>
              Bind PC
            </Link>
          )}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="w-full border border-border px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              Stay on sign in
            </button>
          ) : (
            <Link
              to="/login"
              className="block w-full border border-border px-3 py-2 text-center text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              Back to sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
