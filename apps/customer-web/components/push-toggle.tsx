'use client';

import { useEffect, useState } from 'react';
import { BellRing, BellOff } from 'lucide-react';
import { Button, Card, useToast } from '@/components/ui';
import { disablePush, enablePush, pushCapable, pushState } from '@/lib/push';

/**
 * Enable/disable browser push notifications (v1.4 WS5). Hidden entirely when the
 * browser can't do push or the server hasn't configured VAPID (graceful placeholder).
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
    <Card>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${on ? 'bg-action-primary/10 text-action-primary' : 'bg-background-subtle text-text-muted'}`}
        >
          {on ? <BellRing className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text-primary">Push notifications</p>
          <p className="text-caption text-text-muted">
            {on
              ? 'This device receives push alerts.'
              : 'Get booking, reminder & refund alerts here.'}
          </p>
        </div>
        <Button variant={on ? 'outline' : 'primary'} size="sm" loading={busy} onClick={toggle}>
          {on ? 'Turn off' : 'Enable'}
        </Button>
      </div>
    </Card>
  );
}
