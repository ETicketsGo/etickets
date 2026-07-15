'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Registers the service worker (production only — dev is opted out so it never
 * interferes with hot reload). Surfaces an accessible "update available" banner
 * and reloads once the new worker takes control.
 */
export function SwRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Only reload after the USER accepts an update — never on first install/claim
  // (auto-reloading on the initial controllerchange would interrupt the session).
  const updating = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const onControllerChange = () => {
      if (updating.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Register after `load` so SW install never competes with initial hydration
    // or the first form submission.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
          reg.addEventListener('updatefound', () => {
            const next = reg.installing;
            next?.addEventListener('statechange', () => {
              // A waiting worker with an active controller means a real update.
              if (next.state === 'installed' && navigator.serviceWorker.controller) {
                setWaiting(next);
              }
            });
          });
        })
        .catch(() => undefined);
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return () =>
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, []);

  if (!waiting) return null;

  const applyUpdate = () => {
    updating.current = true;
    waiting.postMessage('SKIP_WAITING');
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[70] flex items-center justify-center gap-3 border-t border-border bg-background-elevated px-4 py-2.5 text-caption text-text-primary shadow-lg"
    >
      A new version of ETicketsGo is available.
      <button
        onClick={applyUpdate}
        className="inline-flex items-center gap-1.5 rounded-md bg-action-primary px-3 py-1.5 font-semibold text-action-primary-foreground hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <RefreshCw className="h-3.5 w-3.5" /> Reload
      </button>
    </div>
  );
}
