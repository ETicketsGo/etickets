'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { MessageCircle, Phone } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { api, type OrganizerConsentPurpose } from '@/lib/api';
import { useToast } from '@/components/ui';
import { PushToggle } from '@/components/push-toggle';
import {
  ACCOUNT_PANEL,
  AccountHeading,
  AccountPage,
  BrandError,
  BrandToggle,
  PANEL_TITLE,
} from '@/components/account-brand';
import { BRAND_LINK } from '@/components/booking-brand';
import { Placeholder } from '@/components/home/parts';
import { SignInRequired, isAuthFailure, useSignedIn } from '@/components/sign-in-required';
import { useSingleFlight } from '@/lib/use-single-flight';

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
 *
 * ── ON THE BRAND LAYER ─────────────────────────────────────────────────────────────
 * Paper, flat white panels and the brand's switch (ink when on, the field grey when off, the
 * knob's side saying it too). Same switches, same names, same rules about required channels.
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
  const signedIn = useSignedIn();
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

  // One audited consent save per switch at a time (see useSingleFlight).
  const once = useSingleFlight();

  const setConsent = useMutation({
    mutationFn: (body: { channel: string; granted: boolean }) => api.setConsent(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing-consent'] });
      toast.push(t('saved'), 'success');
    },
    onError: () => toast.push(t('saveError'), 'error'),
  });

  /*
    Email from organizers, one list per organizer the person follows or ever decided about.
    Separate from the offers switches above, which are ETicketsGo's own marketing: allowing
    one never allows the other.
  */
  const organizerConsent = useQuery({
    queryKey: ['communication-consent'],
    queryFn: () => api.communicationConsent(),
    enabled: signedIn === true,
  });
  const setOrganizerConsent = useMutation({
    mutationFn: (body: {
      organizationId: string;
      purpose: OrganizerConsentPurpose;
      granted: boolean;
    }) => api.setOrganizerConsent(body.organizationId, body.purpose, body.granted),
    onSuccess: (data) => {
      qc.setQueryData(['communication-consent'], data);
      qc.invalidateQueries({ queryKey: ['following'] });
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

  /*
    Somebody with no session is not looking at a broken page - they are looking at somebody
    else's settings, which is why the API refused. Telling them "we couldn't load your
    notification settings" next to a Try again button sent them round a loop that could never
    succeed, and this is the page the public SMS programme links to for turning text messages
    ON, so it was the one route that had to work for a signed-out visitor.

    `signedIn === null` is the first render, before localStorage can be read; showing the
    skeleton there avoids flashing a sign-in prompt at somebody who is signed in.
  */
  if (signedIn === false || isAuthFailure(prefs.error) || isAuthFailure(consent.error)) {
    return (
      <AccountPage>
        <SignInRequired title={t('signInTitle')} description={t('signInDescription')} />
      </AccountPage>
    );
  }
  if (signedIn === null) {
    return (
      <AccountPage>
        <div className="space-y-3" aria-busy="true">
          <Placeholder className="h-16 w-full" />
          <Placeholder className="h-16 w-full" />
        </div>
      </AccountPage>
    );
  }

  if (prefs.isError) {
    return (
      <AccountPage>
        <BrandError message={t('loadError')} onRetry={() => prefs.refetch()} />
      </AccountPage>
    );
  }

  return (
    <AccountPage>
      <AccountHeading title={t('heading')} lead={t('lead')} />

      {/* Browser push registration lives with the existing component; one place asks for the
          permission, and this page only decides what it is used for. */}
      <PushToggle />

      <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
        <h2 className={PANEL_TITLE}>{t('whatsappHeading')}</h2>
        <p className="mt-1 text-brand-ui text-brand-ink-2">{t('whatsappLead')}</p>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-2 text-brand-ui text-brand-ink">
            <MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('whatsappToggleText')}
          </span>
          <BrandToggle
            checked={consentFor('whatsapp:transactional')}
            disabled={!hasPhone || setConsent.isPending}
            aria-label={t('whatsappToggleLabel')}
            onChange={(granted) =>
              once('consent:whatsapp:transactional', () =>
                setConsent
                  .mutateAsync({ channel: 'whatsapp:transactional', granted })
                  .catch(() => undefined),
              )
            }
          />
        </div>
        {!hasPhone && (
          <p className="mt-3 inline-flex items-center gap-2 text-brand-meta text-brand-ink-2">
            <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {/* The existing profile flow owns phone numbers; this points at it rather than
                growing a second way to collect one. */}
            <span>
              {t.rich('addPhone', {
                link: (chunks) => (
                  <Link href="/account/profile" className={BRAND_LINK}>
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          </p>
        )}
      </section>

      <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
        <h2 className={PANEL_TITLE}>{t('whatWeSend')}</h2>
        {prefs.isLoading ? (
          <div className="mt-4 space-y-4" aria-busy="true">
            <Placeholder className="h-16 w-full" />
            <Placeholder className="h-16 w-full" />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-brand-line">
            {prefs.data?.types.map((entry) => {
              if (!KNOWN_TYPES.has(entry.type)) return null;
              const title = t(`types.${entry.type}.title`);
              return (
                <li key={entry.type} className="py-4 first:pt-0 last:pb-0">
                  <p className="text-brand-body font-semibold text-brand-ink">{title}</p>
                  <p className="mt-0.5 text-brand-ui text-brand-ink-2">
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
                            className="text-brand-meta text-brand-ink-2"
                            title={t('emergencyTitle')}
                          >
                            {t('emergencyOnly')}
                          </span>
                        );
                      }
                      return (
                        <label
                          key={c.channel}
                          className="inline-flex min-h-11 items-center gap-2 text-brand-ui text-brand-ink"
                        >
                          <BrandToggle
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
                            <span className="text-brand-meta text-brand-ink-3">
                              {t('required')}
                            </span>
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
        <p className="mt-4 text-brand-meta text-brand-ink-2">{t('requiredNote')}</p>
      </section>

      <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
        <h2 className={PANEL_TITLE}>{t('offersHeading')}</h2>
        <p className="mt-1 text-brand-ui text-brand-ink-2">{t('offersLead')}</p>
        <div className="mt-4 space-y-3">
          {(['email', 'push', 'whatsapp'] as const).map((channel) => (
            <label
              key={channel}
              className="flex min-h-11 items-center justify-between gap-4 text-brand-ui text-brand-ink"
            >
              <span>{channelLabel(channel)}</span>
              <BrandToggle
                checked={consentFor(channel)}
                disabled={consent.isLoading || setConsent.isPending}
                aria-label={t('marketingOn', { channel: channelLabel(channel) })}
                onChange={(granted) =>
                  once(`consent:${channel}`, () =>
                    setConsent.mutateAsync({ channel, granted }).catch(() => undefined),
                  )
                }
              />
            </label>
          ))}
        </div>
      </section>

      <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`} data-testid="organizer-email">
        <h2 className={PANEL_TITLE}>{t('organizersHeading')}</h2>
        <p className="mt-1 text-brand-ui text-brand-ink-2">{t('organizersLead')}</p>
        {organizerConsent.isLoading ? (
          <div className="mt-4 space-y-3" aria-busy="true">
            <Placeholder className="h-12 w-full" />
          </div>
        ) : organizerConsent.isError ? (
          <p className="mt-4 text-brand-meta text-brand-ink-2">{t('organizersLoadError')}</p>
        ) : (organizerConsent.data?.organizers.length ?? 0) === 0 ? (
          <p className="mt-4 text-brand-meta text-brand-ink-2">
            {t.rich('organizersEmpty', {
              link: (chunks) => (
                <Link href="/account/following" className={BRAND_LINK}>
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-brand-line">
            {organizerConsent.data!.organizers.map((org) => (
              <li key={org.organizationId} className="py-4 first:pt-0 last:pb-0">
                <p className="text-brand-body font-semibold text-brand-ink">{org.name}</p>
                <div className="mt-2 space-y-2">
                  {(['ORGANIZER_UPDATES', 'EARLY_ACCESS', 'OFFERS'] as const).map((purpose) => (
                    <label
                      key={purpose}
                      className="flex min-h-11 items-center justify-between gap-4 text-brand-ui text-brand-ink"
                    >
                      <span>{t(`organizerPurposes.${purpose}`)}</span>
                      <BrandToggle
                        checked={org.purposes[purpose]?.granted ?? false}
                        disabled={setOrganizerConsent.isPending}
                        aria-label={t('organizerPurposeFor', {
                          purpose: t(`organizerPurposes.${purpose}`),
                          name: org.name,
                        })}
                        onChange={(granted) =>
                          once(`organizer:${org.organizationId}:${purpose}`, () =>
                            setOrganizerConsent
                              .mutateAsync({
                                organizationId: org.organizationId,
                                purpose,
                                granted,
                              })
                              .catch(() => undefined),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AccountPage>
  );
}
