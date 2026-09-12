'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Mail, UserPlus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { errorMessage, useToast, type WalletTicket } from '@eticketsgo/web-kit';
import type { Locale } from '@eticketsgo/i18n';
import { api } from '@/lib/api';
import { getPathname } from '@/i18n/navigation';
import { Button, Dialog, Input } from '@/components/ui';

type Mode = 'invite' | 'assign';

/**
 * Owner-facing attendee assignment. "Invite" emails a claim link (and returns a
 * copyable link); "Assign" sets the holder directly. Reuses the shared Dialog.
 */
export function AssignAttendeeDialog({
  ticket,
  open,
  onClose,
}: {
  ticket: WalletTicket;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('storefront.assignAttendee');
  const sc = useTranslations('storefront.common');
  const tx = useTranslations('common');
  const qc = useQueryClient();
  const toast = useToast();
  const locale = useLocale() as Locale;
  const [mode, setMode] = useState<Mode>('invite');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setEmail('');
    setName('');
    setPhone('');
    setInviteLink(null);
    setCopied(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: ['wallet'] });

  const invite = useMutation({
    mutationFn: () => api.inviteAttendee(ticket.id, { email, name: name || undefined }),
    onSuccess: (res) => {
      // The invite page in the sender's language; the default locale has no prefix to add.
      setInviteLink(
        `${window.location.origin}${getPathname({ href: `/invite/${res.token}`, locale })}`,
      );
      invalidate();
      toast.push(t('invitedToast'), 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const assign = useMutation({
    mutationFn: () => api.assignAttendee(ticket.id, { name, email, phone: phone || undefined }),
    onSuccess: () => {
      invalidate();
      toast.push(t('assignedToast'), 'success');
      close();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const copyLink = async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const pending = invite.isPending || assign.isPending;

  return (
    <Dialog open={open} onClose={close} title={t('title')}>
      {inviteLink ? (
        <div className="space-y-4">
          <p className="text-[0.9375rem] text-text-secondary">
            {t.rich('emailedLink', {
              email,
              strong: (chunks) => <span className="font-medium text-text-primary">{chunks}</span>,
            })}
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={inviteLink}
              aria-label={t('inviteLinkLabel')}
              className="min-w-0 flex-1 rounded-md border border-border bg-background-subtle px-3 py-2 font-mono text-caption text-text-secondary"
            />
            <Button variant="outline" size="sm" onClick={copyLink}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? sc('copied') : sc('copy')}
            </Button>
          </div>
          <p className="text-caption text-text-muted">{t('acceptNote')}</p>
          <div className="flex justify-end">
            <Button onClick={close}>{tx('action.done')}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Mode switch */}
          <div
            role="tablist"
            aria-label={t('methodLabel')}
            className="grid grid-cols-2 gap-1 rounded-lg bg-background-subtle p-1"
          >
            {(['invite', 'assign'] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  mode === m
                    ? 'bg-background-surface text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {m === 'invite' ? (
                  <Mail className="h-3.5 w-3.5" />
                ) : (
                  <UserPlus className="h-3.5 w-3.5" />
                )}
                {m === 'invite' ? t('inviteTab') : t('assignTab')}
              </button>
            ))}
          </div>

          <Input
            id="attendee-email"
            label={t('email')}
            type="email"
            placeholder={t('emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            id="attendee-name"
            label={mode === 'assign' ? t('name') : t('nameOptional')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {mode === 'assign' && (
            <Input
              id="attendee-phone"
              label={t('phoneOptional')}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          )}

          <p className="text-caption text-text-muted">
            {mode === 'invite' ? t('inviteHint') : t('assignHint')}
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close}>
              {tx('action.cancel')}
            </Button>
            <Button
              loading={pending}
              disabled={!emailValid || (mode === 'assign' && name.trim().length < 1)}
              onClick={() => (mode === 'invite' ? invite.mutate() : assign.mutate())}
            >
              {mode === 'invite' ? t('send') : t('assign')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
