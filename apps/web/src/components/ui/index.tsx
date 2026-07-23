import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-none font-mono font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2 text-sm',
        size === 'lg' && 'px-6 py-3 text-base',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:brightness-110',
        variant === 'secondary' && 'bg-secondary text-secondary-foreground hover:bg-primary/15',
        variant === 'ghost' && 'hover:bg-primary/10 text-muted-foreground hover:text-primary',
        variant === 'outline' &&
          'border border-border bg-background text-foreground hover:border-primary hover:text-primary',
        variant === 'danger' && 'bg-destructive text-destructive-foreground hover:opacity-90',
        className,
      )}
      {...props}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-none border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary/40',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <label
      className={cn('mb-1.5 block text-[11px] uppercase tracking-wider text-accent', className)}
    >
      {children}
    </label>
  );
}

export function Card({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-none border border-border bg-card p-5 text-card-foreground',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-none px-2 py-0.5 font-mono text-xs font-medium',
        tone === 'neutral' && 'border border-border text-muted-foreground',
        tone === 'success' && 'border border-primary/40 text-primary',
        tone === 'warning' && 'border border-warning/40 text-warning',
        tone === 'danger' && 'border border-destructive/40 text-destructive',
        tone === 'info' && 'border border-accent/40 text-accent',
      )}
    >
      {children}
    </span>
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-[100px] w-full rounded-none border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary/40',
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full rounded-none border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/40',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
