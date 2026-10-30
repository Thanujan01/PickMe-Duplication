import * as React from 'react';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'ride-install-dismissed';

/**
 * PWA install affordance (spec section 16). Only Chromium fires
 * `beforeinstallprompt`; elsewhere this renders nothing rather than showing
 * instructions the browser cannot honour.
 */
export function InstallPrompt() {
  const [event, setEvent] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = React.useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  React.useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', () => setEvent(null));
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!event || hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: just hide for this session */
    }
  };

  return (
    <div className="pointer-events-auto mx-3 mb-3 flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-card">
      <div className="rounded-lg bg-secondary p-2">
        <Download className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Install the app</p>
        <p className="truncate text-xs text-muted-foreground">Faster launch and full-screen maps.</p>
      </div>
      <Button
        size="sm"
        onClick={async () => {
          await event.prompt();
          await event.userChoice;
          setEvent(null);
        }}
      >
        Install
      </Button>
      <button
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="rounded-md p-1 text-muted-foreground transition hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
