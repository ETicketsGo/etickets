'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { brandButtonClasses } from '@eticketsgo/web-kit';

/**
 * Registers the service worker (production only — dev is opted out so it never
 * interferes with hot reload). Surfaces an accessible "update available" banner
 * and reloads once the new worker takes control.
 *
 * Rendered by the layout outside every shell, so the banner scopes the brand layer itself.
 */
export function SwRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Only reload after the USER accepts an update — never on first install/claim
  // (auto-reloading on the initial controllerchange would interrupt the session).
  const updating = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    /*
      Whether a worker already controlled THIS page when it loaded. Asked now, not later:
      the worker calls skipWaiting() and claims the page on its very first install, and WebKit
      reports the new controller before the 'installed' event reaches us - so a first-time
      Safari visitor was told 'A new version is available' about the version they were
      already on. A real update is only possible if there was a worker to update.
    */
    const hadController = !!navigator.serviceWorker.controller;

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
          if (reg.waiting && hadController) setWaiting(reg.waiting);
          reg.addEventListener('updatefound', () => {
            const next = reg.installing;
            next?.addEventListener('statechange', () => {
              // A waiting worker for a page that already had a controller means a real update.
              if (next.state === 'installed' && hadController) {
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
      data-brand="customer"
      className="fixed inset-x-0 bottom-0 z-[70] flex items-center justify-center gap-3 border-t border-brand-line bg-brand-surface px-4 py-2.5 font-brand-text text-brand-ui text-brand-ink shadow-brand-overlay"
    >
      A new version of ETicketsGo is available.
      <button type="button" onClick={applyUpdate} className={brandButtonClasses('primary', 'sm')}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload
      </button>
    </div>
  );
}
