'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Dialog,
  Textarea,
  errorMessage,
  useAuthUser,
  useToast,
  type AdminUser,
} from '@eticketsgo/web-kit';
import { holds } from '@/lib/capabilities';

type Action = 'suspend' | 'reinstate' | 'revoke';

const COPY: Record<Action, { title: string; body: string; confirm: string; label: string }> = {
  suspend: {
    title: 'Suspend this account?',
    body: 'They are signed out on every device at once and cannot use their account until somebody reinstates it. Their bookings and tickets are not changed.',
    confirm: 'Suspend',
    label: 'Why are you suspending it?',
  },
  reinstate: {
    title: 'Reinstate this account?',
    body: 'They can sign in again. Their old sessions stay ended, so they sign in fresh.',
    confirm: 'Reinstate',
    label: 'Why (optional)',
  },
  revoke: {
    title: 'Sign this account out everywhere?',
    body: 'Every session ends. A page they already have open can keep working for up to 15 minutes, then asks them to sign in again. Use Suspend to stop them at once.',
    confirm: 'Sign out everywhere',
    label: 'Why (optional)',
  },
};

/**
 * Suspend, reinstate, or sign out one account, for somebody holding USER_SUSPEND.
 *
 * Rendered only for the operator who holds the duty, and not on their own row or (unless they
 * are a super admin) on a super admin's row - the API refuses those either way, and a button
 * that can only end in "you may not do that" is a dead end. Every action asks for a fresh
 * authenticator code through the shared step-up dialog and is written to the audit log with the
 * reason given here. ASCII only.
 */
export function AccountActions({ account }: { account: AdminUser }) {
  const { user } = useAuthUser();
  const toast = useToast();
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');

  const run = useMutation({
    mutationFn: async (a: Action) => {
      const why = reason.trim();
      if (a === 'suspend') return api.admin.accounts.suspend(account.id, why);
      if (a === 'reinstate') return api.admin.accounts.reinstate(account.id, why || undefined);
      return api.admin.accounts.revokeSessions(account.id, why || undefined);
    },
    onSuccess: (_r, a) => {
      toast.push(
        a === 'suspend'
          ? 'Account suspended and signed out everywhere.'
          : a === 'reinstate'
            ? 'Account reinstated.'
            : 'Account signed out everywhere.',
        'success',
      );
      setAction(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (!user || !holds(user, 'USER_SUSPEND')) return null;
  if (account.id === user.id) return null;
  if (account.roles.includes('SUPER_ADMIN') && !user.roles.includes('SUPER_ADMIN')) return null;
  if (account.status === 'DELETED') return null;

  const suspended = account.status === 'SUSPENDED';
  const copy = action ? COPY[action] : null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {suspended ? (
          <Button size="sm" variant="outline" onClick={() => setAction('reinstate')}>
            Reinstate
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setAction('revoke')}>
              Sign out everywhere
            </Button>
            <Button size="sm" variant="danger" onClick={() => setAction('suspend')}>
              Suspend
            </Button>
          </>
        )}
      </div>
      <Dialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={copy?.title ?? ''}
        footer={
          <>
            <Button variant="outline" onClick={() => setAction(null)}>
              Cancel
            </Button>
            <Button
              variant={action === 'suspend' ? 'danger' : 'primary'}
              loading={run.isPending}
              disabled={action === 'suspend' && !reason.trim()}
              onClick={() => action && run.mutate(action)}
            >
              {copy?.confirm}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{copy?.body}</p>
          <Textarea
            label={copy?.label}
            rows={3}
            maxLength={500}
            value={reason}
            hint="Recorded in the audit log with your name."
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Dialog>
    </>
  );
}
