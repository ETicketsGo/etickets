'use client';

import { useEffect, useState } from 'react';
import { BellRing, BellOff } from 'lucide-react';
import { BrandButton } from '@eticketsgo/web-kit';
import { useToast } from '@/components/ui';
import { disablePush, enablePush, pushCapable, pushState } from '@/lib/push';

/**
 * Enable/disable browser push notifications (v1.4 WS5). Hidden entirely when the
 * browser can't do push or the server hasn't configured VAPID (graceful placeholder).
 *
 * Drawn on the brand layer: it appears only on the inbox and notification settings, both
 * brand pages, so it uses their panel, ink icon disc and buttons.
 */
export function PushToggle() {
  const toast = useToast();
  const [state, setState] = useState<'loading' | 'unsupported' | 'on' | 'off'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!pushCapable()) return setState('unsupported');
      const s = await pushState();
      setState(s === 'unsupported' ? 'unsupported' : s === 'granted' ? 'on' : 'off');
    })();
  }, []);

  if (state === 'loading' || state === 'unsupported') return null;

  const on = state === 'on';
  const toggle = async () => {
    setBusy(true);
    try {
      if (on) {
        await disablePush();
        setState('off');
        toast.push('Push notifications turned off.', 'success');
      } else {
        const res = await enablePush();
        if (res.ok) {
          setState('on');
          toast.push('Push notifications enabled.', 'success');
        } else {
          toast.push(
            res.reason === 'denied'
              ? 'Permission was blocked in your browser settings.'
              : 'Push is not available right now.',
            'error',
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-brand-card border border-brand-line bg-brand-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${on ? 'bg-brand-action text-brand-on-action' : 'bg-brand-sunken text-brand-ink-2'}`}
        >
          {on ? (
            <BellRing className="h-5 w-5" aria-hidden />
          ) : (
            <BellOff className="h-5 w-5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">Push notifications</p>
          <p className="text-brand-meta text-brand-ink-2">
            {on
              ? 'This device receives push alerts.'
              : 'Get booking, reminder & refund alerts here.'}
          </p>
        </div>
        <BrandButton
          variant={on ? 'secondary' : 'primary'}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={toggle}
        >
          {on ? 'Turn off' : 'Enable'}
        </BrandButton>
      </div>
    </div>
  );
}
