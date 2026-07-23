import { type ComponentProps, type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';

const ASCII_LOGO = `██╗███╗   ██╗██████╗  ██████╗ ██╗  ██╗
██║████╗  ██║██╔══██╗██╔═══██╗╚██╗██╔╝
██║██╔██╗ ██║██████╔╝██║   ██║ ╚███╔╝ 
██║██║╚██╗██║██╔══██╗██║   ██║ ██╔██╗ 
██║██║ ╚████║██████╔╝╚██████╔╝██╔╝ ██╗
╚═╝╚═╝  ╚═══╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝
 ███████╗██╗      ██████╗ ██╗    ██╗  
 ██╔════╝██║     ██╔═══██╗██║    ██║  
 █████╗  ██║     ██║   ██║██║ █╗ ██║  
 ██╔══╝  ██║     ██║   ██║██║███╗██║  
 ██║     ███████╗╚██████╔╝╚███╔███╔╝  
 ╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝  `;

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex h-full min-h-dvh items-center justify-center overflow-y-auto bg-background px-3 py-8 font-mono text-foreground sm:px-4 sm:py-10">
      <div className="nd-atmosphere" aria-hidden />
      <div className="relative w-full max-w-md animate-fade-in">
        <pre className="mb-3 hidden select-none overflow-x-auto text-center text-[8px] leading-[1.05] text-primary sm:mb-4 sm:block sm:text-[10px] md:text-xs">
          {ASCII_LOGO}
        </pre>
        <p className="mb-2 text-center text-sm font-bold tracking-widest text-primary sm:hidden">
          INBOX FLOW
        </p>
        <p className="mb-6 text-center text-[11px] text-accent">
          {'*> Inbox Flow · inboxflow.io · TUI *'}
        </p>
        <div className="tui-box">
          <div className="tui-box-title">{title}</div>
          <div className="space-y-4 p-4">
            <p className="text-xs text-muted-foreground">
              <span className="tui-tag tui-tag-info">[ INFO ]</span> {subtitle}
            </p>
            {children}
          </div>
        </div>
        {footer ? <div className="mt-4 text-center text-xs text-muted-foreground">{footer}</div> : null}
        <p className="mt-6 text-center text-[10px] text-muted-foreground">
          <Link to="/login" className="text-primary hover:underline">
            ~/inboxflow
          </Link>{' '}
          $ auth
        </p>
      </div>
    </div>
  );
}

export function AuthField({
  label,
  id,
  type,
  className,
  ...props
}: ComponentProps<typeof Input> & { label: string }) {
  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';
  const effectiveType = isPassword && visible ? 'text' : type;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-[11px] uppercase tracking-wider text-accent">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={effectiveType}
          className={cn(
            'rounded-none border-border bg-background font-mono text-sm',
            isPassword && 'pr-10',
            className,
          )}
          {...props}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            tabIndex={0}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-primary"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function AuthSubmit({
  loading,
  children,
  disabled,
}: {
  loading?: boolean;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Button type="submit" className="w-full rounded-none font-mono" disabled={disabled || loading}>
      {loading ? '…' : children}
    </Button>
  );
}
