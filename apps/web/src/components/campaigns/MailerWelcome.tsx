import { Mail } from 'lucide-react';
import { Button } from '@/components/ui';

export function MailerWelcome({
  busy,
  onStart,
  error,
}: {
  busy?: boolean;
  onStart: () => void;
  error?: string | null;
}) {
  const blocked = Boolean(error);
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-y-auto px-4 py-10">
      <div className="tui-box w-full max-w-lg">
        <div className="tui-box-title">Inbox Flow Mailer</div>
        <div className="space-y-5 p-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center border border-primary text-primary">
            <Mail className="h-6 w-6" />
          </div>
          <div>
            <h1 className="page-title">Welcome to Inbox Flow Mailer</h1>
            <p className="page-sub mx-auto mt-2 max-w-sm">
              {blocked
                ? error
                : 'Send your first campaign. Setup opens next — name, SMTP, recipients, then the letter.'}
            </p>
          </div>
          {blocked ? (
            <p className="text-xs text-amber-200" role="alert">
              Bind PC is done. Open the Inbox Flow EXE on this PC to create campaigns.
            </p>
          ) : (
            <Button className="w-full" disabled={busy} onClick={onStart}>
              {busy ? 'Opening setup…' : 'Set up your first campaign'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
