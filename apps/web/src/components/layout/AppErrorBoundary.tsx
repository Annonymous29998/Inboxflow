import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { useLocation } from 'react-router-dom';

type Props = { children: ReactNode; resetKey: string };

type State = { error: Error | null };

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[inboxflow]', error, info.componentStack);
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const admin = typeof document !== 'undefined' && document.documentElement.dataset.shell === 'admin';
    return (
      <div className={admin ? 'if-admin-page p-6' : 'p-6 font-mono text-sm text-emerald-200'}>
        <p className={admin ? 'if-admin-heading text-xl font-semibold' : 'text-lg font-bold'}>This screen hit an error</p>
        <p className={admin ? 'if-admin-lede mt-2 text-sm' : 'mt-2 opacity-80'}>
          The rest of Inbox Flow is still running. Reload this view. Sending on the desktop is not stopped by this.
        </p>
        <p className={admin ? 'if-admin-muted mt-3 break-all text-xs' : 'mt-3 break-all text-xs opacity-60'}>
          {this.state.error.message}
        </p>
        <button
          type="button"
          className={admin ? 'if-admin-btn if-admin-btn-primary mt-4' : 'mt-4 border border-emerald-500 px-3 py-2'}
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}
