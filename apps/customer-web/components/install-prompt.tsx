'use client';

import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { BRAND_FOCUS, brandButtonClasses } from '@eticketsgo/web-kit';

const DISMISS_KEY = 'etg_install_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Add-to-home-screen prompt (v1.4 WS1). Captures the browser's deferred
 * `beforeinstallprompt` and offers an accessible, dismissible install button.
 * Never shown once installed or after the user dismisses it.
 *
 * Pinned over the page from the shell, outside any page's brand scope, so it opens one of its
 * own: a paper card, the ink Install button, the brand focus ring.
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
      data-brand="customer"
      className="fixed inset-x-3 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-brand-card border border-brand-line bg-brand-surface p-3 font-brand-text text-brand-ink shadow-brand-overlay lg:bottom-4 print:hidden"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-brand-control bg-brand-sunken text-brand-ink">
        <Download className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-brand-ui font-semibold text-brand-ink">Install ETicketsGo</p>
        <p className="text-brand-meta text-brand-ink-2">
          Add to your home screen for offline tickets.
        </p>
      </div>
      <button type="button" onClick={install} className={brandButtonClasses('primary', 'sm')}>
        Install
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-brand-control text-brand-ink-2 hover:bg-brand-sunken hover:text-brand-ink ${BRAND_FOCUS}`}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
