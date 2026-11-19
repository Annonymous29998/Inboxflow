import { Mail } from 'lucide-react';
import { Button } from '@/components/ui';

export function MailerWelcome({
  busy,
  onStart,
}: {
  busy?: boolean;
  onStart: () => void;
}) {
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
              Send your first campaign. Setup opens next — name, SMTP, recipients, then the letter.
            </p>
          </div>
          <Button className="w-full" disabled={busy} onClick={onStart}>
            {busy ? 'Opening setup…' : 'Set up your first campaign'}
          </Button>
        </div>
      </div>
    </div>
  );
}
