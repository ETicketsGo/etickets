'use client';

import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

const DISMISS_KEY = 'etg_install_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Add-to-home-screen prompt (v1.4 WS1). Captures the browser's deferred
 * `beforeinstallprompt` and offers an accessible, dismissible install button.
 * Never shown once installed or after the user dismisses it.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(DISMISS_KEY)) return;
    // Already installed (standalone) → never prompt.
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', () => setVisible(false));
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => undefined);
    dismiss();
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Install ETicketsGo"
      className="fixed inset-x-3 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-background-surface p-3 shadow-lg lg:bottom-4"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-action-primary/10 text-action-primary">
        <Download className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.9375rem] font-semibold text-text-primary">Install ETicketsGo</p>
        <p className="text-caption text-text-muted">Add to your home screen for offline tickets.</p>
      </div>
      <button
        onClick={install}
        className="rounded-lg bg-action-primary px-3 py-1.5 text-[0.8125rem] font-semibold text-action-primary-foreground"
      >
        Install
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="rounded-md p-1 text-text-muted hover:text-text-primary"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
