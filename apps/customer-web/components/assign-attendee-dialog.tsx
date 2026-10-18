'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Mail, UserPlus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  BRAND_FOCUS,
  BrandButton,
  errorMessage,
  useToast,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import type { Locale } from '@eticketsgo/i18n';
import { api } from '@/lib/api';
import { getPathname } from '@/i18n/navigation';
import { Dialog } from '@/components/ui';
import { BrandTextField } from '@/components/account-brand';
import { siteUrl } from '@/lib/site-url';
import { PhoneNumberField, usePhoneNumber } from '@/components/phone-number-field';

type Mode = 'invite' | 'assign';

/**
 * Owner-facing attendee assignment. "Invite" emails a claim link (and returns a
 * copyable link); "Assign" sets the holder directly. Reuses the shared Dialog, drawn inside
 * the booking's ticket page on the brand layer, so its fields and buttons are the brand's.
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
  const au = useTranslations('storefront.auth');
  const sc = useTranslations('storefront.common');
  const tx = useTranslations('common');
  const qc = useQueryClient();
  const toast = useToast();
  const locale = useLocale() as Locale;
  const [mode, setMode] = useState<Mode>('invite');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  /*
    The attendee's number, as country + digits like every other phone field here. It was free
    text stored exactly as typed, so "98450 12345" reached the organizer's attendee list with no
    country at all. The country opens on where the buyer is - usually where their guest is too -
    and is theirs to change.
  */
  const phone = usePhoneNumber();
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setEmail('');
    setName('');
    phone.reset();
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
      // On the site's own address: this link is sent to somebody else to trust and open.
      setInviteLink(siteUrl(getPathname({ href: `/invite/${res.token}`, locale })));
      invalidate();
      toast.push(t('invitedToast'), 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const assign = useMutation({
    mutationFn: () =>
      api.assignAttendee(ticket.id, { name, email, phone: phone.e164 || undefined }),
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
          <p className="text-brand-ui text-brand-ink-2">
            {t.rich('emailedLink', {
              email,
              strong: (chunks) => <span className="font-semibold text-brand-ink">{chunks}</span>,
            })}
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={inviteLink}
              aria-label={t('inviteLinkLabel')}
              className={`h-11 min-w-0 flex-1 rounded-brand-control border border-brand-line bg-brand-sunken px-3 font-mono text-brand-meta text-brand-ink-2 ${BRAND_FOCUS}`}
            />
            <BrandButton variant="secondary" onClick={copyLink} className="shrink-0">
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? sc('copied') : sc('copy')}
            </BrandButton>
          </div>
          <p className="text-brand-meta text-brand-ink-2">{t('acceptNote')}</p>
          <div className="flex justify-end">
            <BrandButton onClick={close}>{tx('action.done')}</BrandButton>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Mode switch */}
          <div
            role="tablist"
            aria-label={t('methodLabel')}
            className="grid grid-cols-2 gap-1 rounded-brand-control bg-brand-sunken p-1"
          >
            {(['invite', 'assign'] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                type="button"
                className={`flex min-h-11 items-center justify-center gap-1.5 rounded-brand-control px-3 text-brand-ui font-medium transition-colors duration-150 ${BRAND_FOCUS} ${
                  mode === m
                    ? 'border border-brand-line-strong bg-brand-surface font-semibold text-brand-ink'
                    : 'text-brand-ink-2 hover:text-brand-ink'
                }`}
              >
                {m === 'invite' ? (
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                )}
                {m === 'invite' ? t('inviteTab') : t('assignTab')}
              </button>
            ))}
          </div>

          <BrandTextField
            id="attendee-email"
            label={t('email')}
            type="email"
            placeholder={t('emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <BrandTextField
            id="attendee-name"
            label={mode === 'assign' ? t('name') : t('nameOptional')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {mode === 'assign' && (
            <PhoneNumberField
              phone={phone}
              ids={{ country: 'attendee-phone-country', number: 'attendee-phone' }}
              label={t('phoneOptional')}
              countryLabel={au('countryLabel')}
              countryPlaceholder={au('countryPlaceholder')}
              brand
            />
          )}

          <p className="text-brand-meta text-brand-ink-2">
            {mode === 'invite' ? t('inviteHint') : t('assignHint')}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <BrandButton variant="secondary" onClick={close}>
              {tx('action.cancel')}
            </BrandButton>
            <BrandButton
              aria-busy={pending || undefined}
              disabled={pending || !emailValid || (mode === 'assign' && name.trim().length < 1)}
              onClick={() => (mode === 'invite' ? invite.mutate() : assign.mutate())}
            >
              {mode === 'invite' ? t('send') : t('assign')}
            </BrandButton>
          </div>
        </div>
      )}
    </Dialog>
  );
}
