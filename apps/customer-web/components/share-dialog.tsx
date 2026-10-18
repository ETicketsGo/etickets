'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Check, Copy, Eye, Mail, MessageCircle, Repeat, Shield, Smartphone } from 'lucide-react';
import {
  BRAND_FOCUS,
  BrandButton,
  errorMessage,
  useToast,
  type ShareExpiryValue,
  type SharePermissionValue,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { Dialog } from '@/components/ui';
import { BrandSelectField } from '@/components/account-brand';

/** Each permission's words live at `storefront.shareDialog.permission.<VALUE>`. */
const PERMISSIONS: { value: SharePermissionValue; icon: typeof Eye }[] = [
  { value: 'VIEW', icon: Eye },
  { value: 'GUEST', icon: Shield },
  { value: 'TRANSFER', icon: Repeat },
];

/** Catalogue keys for the expiry options (the API's values are not valid message keys). */
const EXPIRIES: { value: ShareExpiryValue; key: string }[] = [
  { value: '1h', key: 'oneHour' },
  { value: '6h', key: 'sixHours' },
  { value: '24h', key: 'dayHours' },
  { value: 'event_end', key: 'eventEnd' },
  { value: 'never', key: 'never' },
];

/**
 * Secure Experience Sharing dialog: create a scoped, expiring, revocable link.
 *
 * Opened from a booking's ticket page, which is on the brand layer; the kit's Dialog is drawn
 * inside that page, so everything in it uses the brand's fields, buttons and pills.
 */
export function ShareDialog({
  ticket,
  open,
  onClose,
}: {
  ticket: WalletTicket;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('storefront.shareDialog');
  const sc = useTranslations('storefront.common');
  const tx = useTranslations('common');
  const qc = useQueryClient();
  const toast = useToast();
  const [permission, setPermission] = useState<SharePermissionValue>('VIEW');
  const [expiry, setExpiry] = useState<ShareExpiryValue>('24h');
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const shares = useQuery({
    queryKey: ['shares', ticket.id],
    queryFn: () => api.shareActivity(ticket.id),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () => api.createShare(ticket.id, { permission, expiry }),
    onSuccess: (res) => {
      setLink(res.shareUrl);
      setQr(res.qrDataUrl);
      qc.invalidateQueries({ queryKey: ['shares', ticket.id] });
      toast.push(t('createdToast'), 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares', ticket.id] });
      toast.push(t('revokedToast'), 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const reset = () => {
    setLink(null);
    setQr(null);
    setCopied(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  /** A permission's name, or the API's spelling for one the catalogue does not know. */
  const permissionLabel = (value: string) =>
    t.has(`permission.${value}.label`) ? t(`permission.${value}.label`) : value;

  const msg = link ? t('message', { title: ticket.event.title, link }) : '';
  const channels = link
    ? [
        {
          key: 'whatsapp',
          label: 'WhatsApp',
          icon: MessageCircle,
          href: `https://wa.me/?text=${encodeURIComponent(msg)}`,
        },
        {
          key: 'sms',
          label: 'SMS',
          icon: Smartphone,
          href: `sms:?&body=${encodeURIComponent(msg)}`,
        },
        {
          key: 'email',
          label: t('channelEmail'),
          icon: Mail,
          href: `mailto:?subject=${encodeURIComponent(t('emailSubject', { title: ticket.event.title }))}&body=${encodeURIComponent(msg)}`,
        },
      ]
    : [];

  return (
    <Dialog open={open} onClose={close} title={t('title')}>
      {link ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              aria-label={t('linkLabel')}
              className={`h-11 min-w-0 flex-1 rounded-brand-control border border-brand-line bg-brand-sunken px-3 font-mono text-brand-meta text-brand-ink-2 ${BRAND_FOCUS}`}
            />
            <BrandButton variant="secondary" onClick={copy} className="shrink-0">
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? sc('copied') : sc('copy')}
            </BrandButton>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {channels.map((c) => (
              <a
                key={c.key}
                href={c.href}
                target="_blank"
                rel="noreferrer"
                className={`flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-brand-control border border-brand-line-strong bg-brand-surface px-2 py-3 text-brand-meta font-semibold text-brand-ink transition-colors duration-150 hover:border-brand-ink-3 hover:bg-brand-sunken ${BRAND_FOCUS}`}
              >
                <c.icon className="h-4 w-4" aria-hidden />
                {c.label}
              </a>
            ))}
          </div>

          {qr && (
            <div className="flex flex-col items-center">
              <p className="mb-1.5 text-brand-meta text-brand-ink-2">{t('scanHint')}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr}
                alt={t('qrAlt')}
                className="h-40 w-40 rounded-brand-control border border-brand-line bg-white p-2"
              />
            </div>
          )}

          <p className="text-brand-meta text-brand-ink-2">{t(`note.${permission}`)}</p>

          <div className="flex flex-wrap justify-between gap-2">
            <BrandButton variant="secondary" onClick={reset}>
              {t('newLink')}
            </BrandButton>
            <BrandButton onClick={close}>{tx('action.done')}</BrandButton>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-brand-ui font-medium text-brand-ink">
              {t('whatCan')}
            </legend>
            <div className="space-y-2">
              {PERMISSIONS.map((p) => (
                <label
                  key={p.value}
                  // Chosen is an ink outline, two pixels, as well as the radio's own dot.
                  className={`flex cursor-pointer items-start gap-3 rounded-brand-control border p-3 transition-colors duration-150 ${
                    permission === p.value
                      ? 'border-brand-ink bg-brand-sunken ring-1 ring-brand-ink'
                      : 'border-brand-line-strong bg-brand-surface hover:border-brand-ink-3'
                  }`}
                >
                  <input
                    type="radio"
                    name="permission"
                    value={p.value}
                    checked={permission === p.value}
                    onChange={() => setPermission(p.value)}
                    className={`mt-0.5 h-4 w-4 accent-brand-ink ${BRAND_FOCUS}`}
                  />
                  <span>
                    <span className="flex items-center gap-1.5 text-brand-ui font-semibold text-brand-ink">
                      <p.icon className="h-3.5 w-3.5" aria-hidden />{' '}
                      {t(`permission.${p.value}.label`)}
                    </span>
                    <span className="block text-brand-meta text-brand-ink-2">
                      {t(`permission.${p.value}.hint`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <BrandSelectField
            id="share-expiry"
            label={t('expires')}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as ShareExpiryValue)}
          >
            {EXPIRIES.map((x) => (
              <option key={x.value} value={x.value}>
                {t(`expiry.${x.key}`)}
              </option>
            ))}
          </BrandSelectField>

          {/* Existing shares */}
          {shares.data && shares.data.shares.length > 0 && (
            <div>
              <p className="mb-1.5 text-brand-ui font-medium text-brand-ink">{t('activeLinks')}</p>
              <ul className="space-y-1.5">
                {shares.data.shares
                  .filter((s) => s.status === 'PENDING')
                  .map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-2 rounded-brand-control border border-brand-line px-3 py-1 text-brand-meta"
                    >
                      <span className="text-brand-ink-2">
                        {t('activeLine', {
                          permission: permissionLabel(s.permission),
                          count: s.openCount,
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => revoke.mutate(s.id)}
                        className={`min-h-11 rounded-brand-control px-2 font-semibold text-brand-critical underline-offset-4 hover:underline ${BRAND_FOCUS}`}
                      >
                        {t('revoke')}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <BrandButton variant="secondary" onClick={close}>
              {tx('action.cancel')}
            </BrandButton>
            <BrandButton
              aria-busy={create.isPending || undefined}
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('create')}
            </BrandButton>
          </div>
        </div>
      )}
    </Dialog>
  );
}
