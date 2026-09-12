'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { MessageCircle, Phone } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Card, ErrorState, Skeleton, Toggle, useToast } from '@/components/ui';
import { PushToggle } from '@/components/push-toggle';

/**
 * What you receive, and where.
 *
 * ── WHY REQUIRED CHANNELS ARE SHOWN AND NOT HIDDEN ─────────────────────────────────
 * Policy guarantees some channels — the inbox always, and email for anything about a booking
 * — so nobody can end up in a state where a cancelled show reaches them nowhere. There were
 * two ways to reflect that here and only one of them is honest.
 *
 * Offering them as switches would lie twice: once by implying the message can be stopped, and
 * again when it arrives anyway. Hiding them would leave somebody unable to see that we email
 * them about their bookings — which is precisely what a privacy-minded person opened this page
 * to find out. So they are shown, and marked as required, with the reason next to them.
 *
 * ── WHY THE EMERGENCY SMS IS NOT A TOGGLE ──────────────────────────────────────────
 * It is not a channel anybody subscribes to. It opens only if a cancelled show reached you
 * nowhere else, thirty minutes later, once. Presenting it as a preference would invite people
 * to switch off the one message designed to catch the case where every other message failed.
 */

/** Types this page describes; their words live at `notificationSettings.types.<TYPE>`. */
const KNOWN_TYPES = new Set([
  'BOOKING_CONFIRMED',
  'SHOW_CANCELLED',
  'SHOW_CHANGED',
  'BOOKING_CANCELLED',
  'REFUND_COMPLETED',
  'EVENT_REMINDER',
]);

/** Channels with a name in the catalogue; anything else is shown as the API spells it. */
const KNOWN_CHANNELS = new Set(['email', 'push', 'whatsapp', 'sms']);

export default function NotificationSettingsPage() {
  const t = useTranslations('storefront.notificationSettings');
  const qc = useQueryClient();
  const toast = useToast();

  const channelLabel = (channel: string) =>
    KNOWN_CHANNELS.has(channel) ? t(`channels.${channel}`) : channel;

  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.notificationPreferences(),
  });
  const consent = useQuery({
    queryKey: ['marketing-consent'],
    queryFn: () => api.consent(),
  });

  const setPreference = useMutation({
    mutationFn: (body: { type: string; channel: string; enabled: boolean }) =>
      api.setNotificationPreference(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-preferences'] }),
    onError: () => toast.push(t('saveError'), 'error'),
  });

  const setConsent = useMutation({
    mutationFn: (body: { channel: string; granted: boolean }) => api.setConsent(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing-consent'] });
      toast.push(t('saved'), 'success');
    },
    onError: () => toast.push(t('saveError'), 'error'),
  });

  const consentFor = (channel: string) =>
    consent.data?.channels.find((c) => c.channel === channel)?.granted ?? false;

  /*
    WhatsApp needs somewhere to send to. The answer comes from the preferences endpoint rather
    than from the profile, because that is the API that knows what a destination is -- the
    account's own number, which is exactly what the SMS and WhatsApp channels resolve at send
    time. A toggle that cannot work should say why rather than failing silently afterwards.
  */
  const hasPhone = prefs.data?.destinations.hasPhone ?? false;

  if (prefs.isError) {
    return <ErrorState message={t('loadError')} onRetry={() => prefs.refetch()} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h3 font-bold tracking-tight text-text-primary">{t('heading')}</h1>
        <p className="mt-1 text-body-sm text-text-secondary">{t('lead')}</p>
      </div>

      {/* Browser push registration lives with the existing component; one place asks for the
          permission, and this page only decides what it is used for. */}
      <PushToggle />

      <Card className="p-5">
        <h2 className="text-h5 font-semibold text-text-primary">{t('whatsappHeading')}</h2>
        <p className="mt-1 text-body-sm text-text-secondary">{t('whatsappLead')}</p>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-2 text-body-sm text-text-primary">
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {t('whatsappToggleText')}
          </span>
          <Toggle
            checked={consentFor('whatsapp:transactional')}
            disabled={!hasPhone || setConsent.isPending}
            aria-label={t('whatsappToggleLabel')}
            onChange={(granted) =>
              setConsent.mutate({ channel: 'whatsapp:transactional', granted })
            }
          />
        </div>
        {!hasPhone && (
          <p className="mt-3 inline-flex items-center gap-2 text-caption text-text-muted">
            <Phone className="h-3.5 w-3.5" aria-hidden="true" />
            {/* The existing profile flow owns phone numbers; this points at it rather than
                growing a second way to collect one. */}
            <span>
              {t.rich('addPhone', {
                link: (chunks) => (
                  <Link href="/account/profile" className="underline">
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          </p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-h5 font-semibold text-text-primary">{t('whatWeSend')}</h2>
        {prefs.isLoading ? (
          <div className="mt-4 space-y-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {prefs.data?.types.map((entry) => {
              if (!KNOWN_TYPES.has(entry.type)) return null;
              const title = t(`types.${entry.type}.title`);
              return (
                <li key={entry.type} className="py-4 first:pt-0 last:pb-0">
                  <p className="text-body font-medium text-text-primary">{title}</p>
                  <p className="mt-0.5 text-body-sm text-text-secondary">
                    {t(`types.${entry.type}.description`)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
                    {entry.channels.map((c) => {
                      /*
                        The emergency SMS. Not a preference: it opens only when a cancelled
                        show reached you nowhere else. Explaining it is better than offering a
                        switch for the message that exists to catch every other one failing.
                      */
                      if (c.deferred) {
                        return (
                          <span
                            key={c.channel}
                            className="text-caption text-text-muted"
                            title={t('emergencyTitle')}
                          >
                            {t('emergencyOnly')}
                          </span>
                        );
                      }
                      return (
                        <label
                          key={c.channel}
                          className="inline-flex items-center gap-2 text-body-sm text-text-primary"
                        >
                          <Toggle
                            checked={c.enabled}
                            disabled={c.required || setPreference.isPending}
                            aria-label={t('channelFor', {
                              channel: channelLabel(c.channel),
                              type: title,
                            })}
                            onChange={(enabled) =>
                              setPreference.mutate({
                                type: entry.type,
                                channel: c.channel,
                                enabled,
                              })
                            }
                          />
                          <span>{channelLabel(c.channel)}</span>
                          {c.required && (
                            <span className="text-caption text-text-muted">{t('required')}</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-caption text-text-muted">{t('requiredNote')}</p>
      </Card>

      <Card className="p-5">
        <h2 className="text-h5 font-semibold text-text-primary">{t('offersHeading')}</h2>
        <p className="mt-1 text-body-sm text-text-secondary">{t('offersLead')}</p>
        <div className="mt-4 space-y-3">
          {(['email', 'push', 'whatsapp'] as const).map((channel) => (
            <label
              key={channel}
              className="flex items-center justify-between gap-4 text-body-sm text-text-primary"
            >
              <span>{channelLabel(channel)}</span>
              <Toggle
                checked={consentFor(channel)}
                disabled={consent.isLoading || setConsent.isPending}
                aria-label={t('marketingOn', { channel: channelLabel(channel) })}
                onChange={(granted) => setConsent.mutate({ channel, granted })}
              />
            </label>
          ))}
        </div>
      </Card>
    </div>
  );
}
