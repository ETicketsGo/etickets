'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button, Card, Input, Skeleton, errorMessage, useToast } from '@eticketsgo/web-kit';
import { CheckCircle2, Phone } from 'lucide-react';
import { ErrorState } from '@/components/ui';
import { api, tokenStore } from '@/lib/api';
import { useMounted } from '@/lib/use-mounted';
import { dateOnly } from '@/lib/format';

export default function ProfilePage() {
  const t = useTranslations('storefront.profile');
  const router = useRouter();
  const mounted = useMounted();
  const qc = useQueryClient();
  const toast = useToast();
  const [fullName, setFullName] = useState('');
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
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');

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

  const sendCode = useMutation({
    mutationFn: () => api.requestAttachPhoneCode(phone),
    onSuccess: () => {
      setPhoneStep('confirming');
      toast.push(t('phoneSent'), 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
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
    <div className="mx-auto max-w-lg space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">{t('heading')}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">{t('lead')}</p>
      </div>
      {me.isError ? (
        <ErrorState message={t('loadError')} onRetry={() => me.refetch()} />
      ) : !mounted || me.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Card>
          <div className="space-y-4">
            <Input
              id="name"
              label={t('fullName')}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Input id="email" label={t('email')} value={me.data?.email ?? ''} disabled />
            <Button
              loading={save.isPending}
              disabled={fullName.trim().length < 2}
              onClick={() => save.mutate()}
            >
              {t('save')}
            </Button>
          </div>
        </Card>
      )}

      {mounted && !me.isLoading && !me.isError && (
        <>
          <Card>
            <h2 className="text-title font-semibold text-text-primary">{t('phoneHeading')}</h2>
            <p className="mt-1 text-[0.9375rem] text-text-muted">{t('phoneLead')}</p>

            {me.data?.phone ? (
              <p className="mt-4 flex flex-wrap items-center gap-2 text-[0.9375rem] text-text-primary">
                <Phone className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                <span className="tabular-nums">{me.data.phone}</span>
                {me.data.phoneVerified && (
                  <span className="inline-flex items-center gap-1 text-caption text-status-success">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    {t('phoneVerified')}
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-4 text-[0.9375rem] text-text-muted">{t('phoneNone')}</p>
            )}

            {phoneStep === 'idle' && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setPhone(me.data?.phone ?? '');
                  setPhoneStep('entering');
                }}
              >
                {me.data?.phone ? t('phoneChange') : t('phoneAdd')}
              </Button>
            )}

            {phoneStep === 'entering' && (
              <div className="mt-4 space-y-3">
                <Input
                  id="phone"
                  label={t('phoneLabel')}
                  value={phone}
                  inputMode="tel"
                  autoComplete="tel"
                  onChange={(e) => setPhone(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={sendCode.isPending}
                    /*
                      A bare national number is refused by the server, so the button waits for
                      something that could plausibly be dialled rather than spending an SMS on
                      a typo. The server is still the judge.
                    */
                    disabled={phone.replace(/\D/g, '').length < 8}
                    onClick={() => sendCode.mutate()}
                  >
                    {t('phoneSend')}
                  </Button>
                  <Button variant="outline" onClick={() => setPhoneStep('idle')}>
                    {t('phoneCancel')}
                  </Button>
                </div>
              </div>
            )}

            {phoneStep === 'confirming' && (
              <div className="mt-4 space-y-3">
                <Input
                  id="code"
                  label={t('phoneCodeLabel')}
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={confirmPhone.isPending}
                    disabled={code.length !== 6}
                    onClick={() => confirmPhone.mutate()}
                  >
                    {t('phoneConfirm')}
                  </Button>
                  <Button variant="outline" onClick={() => setPhoneStep('entering')}>
                    {t('phoneCancel')}
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* Facts about the account, stated rather than editable - nobody sets their own
              joining date, and a field that looks editable and is not is worse than a line
              of text. */}
          {me.data?.memberSince && (
            <Card>
              <h2 className="text-title font-semibold text-text-primary">{t('detailsHeading')}</h2>
              <dl className="mt-3 flex items-baseline justify-between gap-4 text-[0.9375rem]">
                <dt className="text-text-secondary">{t('memberSince')}</dt>
                <dd className="text-text-primary">{dateOnly(me.data.memberSince)}</dd>
              </dl>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
