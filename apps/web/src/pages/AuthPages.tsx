import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AuthField, AuthLayout, AuthSubmit } from '@/components/layout/AuthLayout';
import { useAuthStore } from '@/stores/auth';

export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needs2FA, setNeeds2FA] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email, password, totpCode || undefined);
      if (result.requires2FA) {
        setNeeds2FA(true);
        return;
      }
      navigate('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Access your organization control panel">
      <form className="space-y-4" onSubmit={onSubmit}>
        <AuthField
          label="Email"
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Password"
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needs2FA ? (
          <AuthField
            label="Authenticator code"
            id="totp"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            placeholder="000000"
          />
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AuthSubmit loading={loading}>Sign in</AuthSubmit>
        <div className="text-center text-sm">
          <Link to="/forgot-password" className="text-muted-foreground hover:text-primary">
            Forgot password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

/** Public registration is disabled — Screen Connect style: sign-in only. */
export function RegisterPage() {
  return <Navigate to="/login" replace />;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { api } = await import('@/lib/api');
      await api.post('/api/auth/forgot-password', { email });
      setDone(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Reset password" subtitle="Enter your account email for a reset link">
      {done ? (
        <p className="text-sm text-muted-foreground">
          <span className="tui-tag tui-tag-ok">[ OK ]</span> If that email exists, a reset link was
          sent.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <AuthField
            label="Email"
            id="forgot-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <AuthSubmit loading={loading}>Send reset link</AuthSubmit>
        </form>
      )}
      <div className="pt-2 text-center text-sm">
        <Link to="/login" className="text-muted-foreground hover:text-primary">
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') || '';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { api } = await import('@/lib/api');
    await api.post('/api/auth/reset-password', { token, password });
    setDone(true);
    setTimeout(() => navigate('/login'), 1500);
  }

  return (
    <AuthLayout title="New password" subtitle="Choose a new password for your account">
      {done ? (
        <p className="text-sm text-muted-foreground">
          <span className="tui-tag tui-tag-ok">[ OK ]</span> Password updated. Redirecting…
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <AuthField
            label="New password"
            id="new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <AuthSubmit>Update password</AuthSubmit>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [status, setStatus] = useState('Verifying…');
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setStatus('Missing token');
      return;
    }
    import('@/lib/api').then(({ api }) =>
      api
        .post('/api/auth/verify-email', { token })
        .then(() => setStatus('Email verified. You can sign in.'))
        .catch(() => setStatus('Invalid or expired verification link.')),
    );
  }, []);

  return (
    <AuthLayout title="Email verification" subtitle="Confirming your email address">
      <p className="text-sm text-muted-foreground">{status}</p>
      <div className="pt-2 text-center text-sm">
        <Link to="/login" className="text-primary hover:underline">
          Go to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
