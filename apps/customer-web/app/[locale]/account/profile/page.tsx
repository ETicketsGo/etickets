'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { BrandButton, errorMessage, useToast } from '@eticketsgo/web-kit';
import { CheckCircle2, Phone } from 'lucide-react';
import { PhoneNumberField, usePhoneNumber } from '@/components/phone-number-field';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { useSmsCapability } from '@/lib/sign-in-modes';
import { useMounted } from '@/lib/use-mounted';
import { dateOnly } from '@/lib/format';
import {
  ACCOUNT_PANEL,
  AccountHeading,
  AccountPage,
  BrandError,
  BrandSelectField,
  BrandTextField,
  PANEL_TITLE,
} from '@/components/account-brand';
import { Placeholder } from '@/components/home/parts';
import { RESIDENCE_COUNTRIES } from '@eticketsgo/shared-types';
import { api as wk } from '@eticketsgo/web-kit';
import { OrganizerEmailStep } from '@/components/organizer-email-step';
import { useSignOut } from '@/lib/use-shell-auth';

/*
  The profile on the brand layer: the same three panels (name and email, mobile number,
  account facts) as flat white panels on paper, with the brand's fields and ink buttons. It was
  the kit's grey card with blue buttons. Same fields, same ids, same steps and same rules.
*/

export default function ProfilePage() {
  const t = useTranslations('storefront.profile');
  const a = useTranslations('storefront.auth');
  const router = useRouter();
  const mounted = useMounted();
  const qc = useQueryClient();
  const toast = useToast();
  const [fullName, setFullName] = useState('');
  const signOut = useSignOut();
  /*
    "Sign out everywhere". POST /auth/logout-all already existed and nothing offered it: a
    customer who lost a phone, or used a shared computer, had no way to end those sessions.
    Sessions are per site (storefront, console, app each hold their own), so this is the one
    button that reaches all of them.
  */
  const signOutEverywhere = useMutation({
    mutationFn: () => wk.auth.logoutAll(),
    onSuccess: () => signOut(),
    onError: () => toast.push(t('signOutEverywhereFailed'), 'error'),
  });
  /*
    Adding a mobile number, in the two steps the platform already uses everywhere else.

    ── WHY THIS SCREEN NEEDED IT ──────────────────────────────────────────────────────
    Notification settings offers WhatsApp for booking updates, disables the switch until the
    account has a number, and says "Add a phone number" with a link to THIS page. There was no
    phone field here, so the link went to a page that could not do what it promised and the
    switch could never be turned on by anybody.

    A number is only ever stored once a code proves it - the same rule as phone sign-in, and
    the reason an unverified number is never written down at all.
  */
  const [phoneStep, setPhoneStep] = useState<'idle' | 'entering' | 'confirming'>('idle');
  /*
    Country + number, opening on where the visitor is - the same field sign-in uses.

    This was one free-text box, and the server refuses a number without its country code, so
    somebody in the United States typing their own ten digits was told to "start your number
    with the country code". The country is now its own choice, already made for them.
  */
  const phoneField = usePhoneNumber();
  const phone = phoneField.e164;
  const [code, setCode] = useState('');
  // Which countries a code can reach. Absent from an older API: then we simply try.
  const { smsCountries } = useSmsCapability();
  const smsBlocked =
    smsCountries !== undefined &&
    (smsCountries.length === 0 ||
      (phoneField.country !== '' && !smsCountries.includes(phoneField.country)));

  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/profile');
  }, [router]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    // Not `typeof window`: the server drew the form and the client's first render the skeleton,
    // a hydration mismatch. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });

  useEffect(() => {
    if (me.data) setFullName(me.data.fullName);
  }, [me.data]);

  const save = useMutation({
    mutationFn: () => api.updateProfile(fullName),
    onSuccess: () => {
      toast.push(t('updated'), 'success');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /*
    Where the person lives - OPTIONAL, and only ever what they choose here. Never filled in from
    their phone number (+1 is the United States and Canada), where they browse from, or where
    they bought a ticket. "Not said" is a real answer and stays one until they change it.
  */
  const [residence, setResidence] = useState('');
  useEffect(() => {
    if (me.data) setResidence(me.data.countryOfResidence ?? '');
  }, [me.data]);
  const saveResidence = useMutation({
    mutationFn: () => api.updateResidence(residence || null),
    onSuccess: () => {
      toast.push(t('residenceSaved'), 'success');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const sendCode = useMutation({
    mutationFn: () => api.requestAttachPhoneCode(phone),
    onSuccess: () => {
      setPhoneStep('confirming');
      toast.push(t('phoneSent'), 'success');
    },
    onError: (e) =>
      toast.push(
        // The API's sentence is written for the sign-in page ("sign in with your email
        // instead"), which is the wrong advice on a profile somebody is already signed into.
        e instanceof ApiRequestError && e.code === 'SMS_UNAVAILABLE'
          ? t('phoneSmsUnavailable')
          : errorMessage(e),
        'error',
      ),
  });

  const confirmPhone = useMutation({
    mutationFn: () => api.attachPhone(phone, code),
    onSuccess: () => {
      setPhoneStep('idle');
      setCode('');
      toast.push(t('phoneSaved'), 'success');
      // Both keys: the profile reads `me`, and the header's account menu reads `auth, me`.
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <AccountPage width="narrow">
      <AccountHeading title={t('heading')} lead={t('lead')} />
      {me.isError ? (
        <BrandError message={t('loadError')} onRetry={() => me.refetch()} />
      ) : !mounted || me.isLoading ? (
        <Placeholder className="h-48 w-full" />
      ) : (
        <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
          <div className="space-y-4">
            <BrandTextField
              id="name"
              label={t('fullName')}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <BrandTextField id="email" label={t('email')} value={me.data?.email ?? ''} disabled />
            <BrandButton
              aria-busy={save.isPending || undefined}
              disabled={save.isPending || fullName.trim().length < 2}
              onClick={() => save.mutate()}
            >
              {t('save')}
            </BrandButton>
          </div>
        </section>
      )}

      {mounted && !me.isLoading && !me.isError && (
        <>
          <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
            <h2 className={PANEL_TITLE}>{t('phoneHeading')}</h2>
            <p className="mt-1 text-brand-ui text-brand-ink-2">{t('phoneLead')}</p>

            {me.data?.phone ? (
              <p className="mt-4 flex flex-wrap items-center gap-2 text-brand-body text-brand-ink">
                <Phone className="h-4 w-4 shrink-0 text-brand-ink-3" aria-hidden />
                <span className="tabular-nums">{me.data.phone}</span>
                {me.data.phoneVerified && (
                  <span className="inline-flex h-6 items-center gap-1 rounded-full bg-brand-positive-tint px-2.5 text-brand-meta font-semibold text-brand-positive">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    {t('phoneVerified')}
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-4 text-brand-ui text-brand-ink-2">{t('phoneNone')}</p>
            )}

            {phoneStep === 'idle' && (
              <BrandButton
                variant="secondary"
                className="mt-4"
                onClick={() => {
                  phoneField.reset(me.data?.phone);
                  setPhoneStep('entering');
                }}
              >
                {me.data?.phone ? t('phoneChange') : t('phoneAdd')}
              </BrandButton>
            )}

            {phoneStep === 'entering' && (
              <div className="mt-4 space-y-3">
                <PhoneNumberField
                  phone={phoneField}
                  ids={{ country: 'phone-country', number: 'phone' }}
                  label={t('phoneLabel')}
                  countryLabel={a('countryLabel')}
                  countryPlaceholder={a('countryPlaceholder')}
                  brand
                />
                {smsBlocked && (
                  <p role="status" className="text-brand-meta text-brand-ink-2">
                    {t('phoneSmsUnavailable')}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <BrandButton
                    aria-busy={sendCode.isPending || undefined}
                    /*
                      Waits for something that could plausibly be dialled rather than spending
                      an SMS on a typo, and for a country a code can reach. The server is still
                      the judge.
                    */
                    disabled={
                      sendCode.isPending || smsBlocked || !phone || phoneField.national.length < 6
                    }
                    onClick={() => sendCode.mutate()}
                  >
                    {t('phoneSend')}
                  </BrandButton>
                  <BrandButton variant="secondary" onClick={() => setPhoneStep('idle')}>
                    {t('phoneCancel')}
                  </BrandButton>
                </div>
              </div>
            )}

            {phoneStep === 'confirming' && (
              <div className="mt-4 space-y-3">
                <BrandTextField
                  id="code"
                  label={t('phoneCodeLabel')}
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <div className="flex flex-wrap gap-2">
                  <BrandButton
                    aria-busy={confirmPhone.isPending || undefined}
                    disabled={confirmPhone.isPending || code.length !== 6}
                    onClick={() => confirmPhone.mutate()}
                  >
                    {t('phoneConfirm')}
                  </BrandButton>
                  <BrandButton variant="secondary" onClick={() => setPhoneStep('entering')}>
                    {t('phoneCancel')}
                  </BrandButton>
                </div>
              </div>
            )}
          </section>

          <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
            <h2 className={PANEL_TITLE}>{t('residenceHeading')}</h2>
            <p className="mt-1 text-brand-ui text-brand-ink-2">{t('residenceLead')}</p>
            <div className="mt-4 space-y-3">
              <BrandSelectField
                id="residence"
                label={t('residenceLabel')}
                value={residence}
                onChange={(e) => setResidence(e.target.value)}
              >
                <option value="">{t('residenceNotSaid')}</option>
                {RESIDENCE_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </BrandSelectField>
              <BrandButton
                variant="secondary"
                aria-busy={saveResidence.isPending || undefined}
                disabled={
                  saveResidence.isPending || residence === (me.data?.countryOfResidence ?? '')
                }
                onClick={() => saveResidence.mutate()}
              >
                {t('residenceSave')}
              </BrandButton>
            </div>
          </section>

          {/*
            ANY phone-only account can add an email here and confirm it with a code (it used to
            be offered to organizers only, so a phone-only customer saw a locked, empty field and
            no way to add one). An organizer sees the organizer wording.
          */}
          {me.data && !me.data.email ? (
            <OrganizerEmailStep
              purpose={
                me.data.roles?.some((r) => r === 'ORGANIZER_OWNER' || r === 'ORGANIZER_MANAGER')
                  ? 'organizer'
                  : 'account'
              }
            />
          ) : null}

          {/* Facts about the account, stated rather than editable - nobody sets their own
              joining date, and a field that looks editable and is not is worse than a line
              of text. */}
          {me.data?.memberSince && (
            <section className={`${ACCOUNT_PANEL} p-5 sm:p-6`}>
              <h2 className={PANEL_TITLE}>{t('detailsHeading')}</h2>
              <dl className="mt-3 flex items-baseline justify-between gap-4 text-brand-ui">
                <dt className="text-brand-ink-2">{t('memberSince')}</dt>
                <dd className="tabular-nums text-brand-ink">{dateOnly(me.data.memberSince)}</dd>
              </dl>
            </section>
          )}

          <section className={`${ACCOUNT_PANEL} space-y-3 p-5 sm:p-6`}>
            <h2 className={PANEL_TITLE}>{t('signOutEverywhereHeading')}</h2>
            <p className="text-brand-ui text-brand-ink-2">{t('signOutEverywhereLead')}</p>
            <BrandButton
              variant="secondary"
              data-testid="sign-out-everywhere"
              aria-busy={signOutEverywhere.isPending || undefined}
              disabled={signOutEverywhere.isPending}
              onClick={() => signOutEverywhere.mutate()}
            >
              {t('signOutEverywhere')}
            </BrandButton>
          </section>
        </>
      )}
    </AccountPage>
  );
}
